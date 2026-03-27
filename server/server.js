require('dotenv').config();
const express = require('express');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const db = require('./database');

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'change-me-in-production';

app.use(cors({ origin: process.env.ALLOWED_ORIGIN || '*', optionsSuccessStatus: 200 }));
app.use(express.json());

const clientPath = path.join(__dirname, '..', 'client');
app.use(express.static(clientPath));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const uploadDir = path.join(__dirname, 'uploads');
    if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    cb(null, Date.now() + '-' + Math.round(Math.random() * 1e9) + path.extname(file.originalname));
  }
});
const upload = multer({ storage });

const authenticateToken = (req, res, next) => {
  const token = (req.headers['authorization'] || '').split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Требуется авторизация' });
  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) return res.status(403).json({ error: 'Недействительный токен' });
    req.user = user;
    next();
  });
};

const requireAdmin = (req, res, next) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Доступ запрещён' });
  next();
};

// ── SMS via Twilio ────────────────────────────────────────────
async function sendSms(phone, message) {
  if (process.env.SMS_REAL !== 'true') {
    console.log(`[SMS-DEV] ${phone} → ${message}`);
    return;
  }
  const twilio = require('twilio');
  const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
  await client.messages.create({
    body: message,
    from: process.env.TWILIO_PHONE_NUMBER,
    to: phone
  });
}

function generateCode() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

function formatParking(p) {
  return {
    ...p,
    pricePerHour: parseFloat(p.pricePerHour),
    pricePerDay:  p.pricePerDay ? parseFloat(p.pricePerDay) : null,
    lat: parseFloat(p.lat),
    lng: parseFloat(p.lng),
    hasCharging: Boolean(p.hasCharging),
    hasSecurity: Boolean(p.hasSecurity)
  };
}

// ── AUTH ──────────────────────────────────────────────────────
app.post('/api/auth/request-code', async (req, res) => {
  try {
    const { phone } = req.body;
    if (!phone) return res.status(400).json({ error: 'Телефон обязателен' });
    const code = generateCode();
    const expiresAt = new Date(Date.now() + 5 * 60 * 1000).toISOString();
    await db.run('INSERT INTO verification_codes (phone, code, expiresAt) VALUES (?, ?, ?)', [phone, code, expiresAt]);
    await sendSms(phone, `Ваш код ParkShare: ${code}. Действителен 5 минут.`);
    res.json({ message: 'Код отправлен' });
  } catch (err) {
    console.error('request-code error:', err);
    res.status(500).json({ error: 'Не удалось отправить SMS. Попробуйте позже.' });
  }
});

app.post('/api/auth/verify-code', async (req, res) => {
  try {
    const { phone, code } = req.body;
    if (!phone || !code) return res.status(400).json({ error: 'Телефон и код обязательны' });
    const record = await db.get(
      `SELECT * FROM verification_codes WHERE phone=? AND code=? AND used=0 AND expiresAt>datetime('now') ORDER BY createdAt DESC LIMIT 1`,
      [phone, code]
    );
    if (!record) return res.status(400).json({ error: 'Неверный или просроченный код' });
    await db.run('UPDATE verification_codes SET used=1 WHERE id=?', [record.id]);
    let user = await db.get('SELECT * FROM users WHERE phone=?', [phone]);
    if (!user) {
      const r = await db.run('INSERT INTO users (phone, role) VALUES (?, ?)', [phone, null]);
      user = { id: r.lastID, phone, role: null };
    } else {
      user = await db.get('SELECT * FROM users WHERE id=?', [user.id]);
    }
    const token = jwt.sign({ id: user.id, phone: user.phone, role: user.role }, JWT_SECRET, { expiresIn: '7d' });
    res.json({ token, user });
  } catch (err) {
    console.error('verify-code error:', err);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

app.patch('/api/users/role', authenticateToken, async (req, res) => {
  try {
    const { role } = req.body;
    if (!['driver','owner','both'].includes(role)) return res.status(400).json({ error: 'Некорректная роль' });
    await db.run('UPDATE users SET role=?, updatedAt=datetime("now") WHERE id=?', [role, req.user.id]);
    const user = await db.get('SELECT * FROM users WHERE id=?', [req.user.id]);
    const token = jwt.sign({ id: user.id, phone: user.phone, role: user.role }, JWT_SECRET, { expiresIn: '7d' });
    res.json({ token, user });
  } catch (err) {
    console.error('set-role error:', err);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// ── PARKINGS ──────────────────────────────────────────────────
app.get('/api/parkings', authenticateToken, async (req, res) => {
  try {
    let q = `SELECT p.*, u.fullName as ownerName FROM parking_spots p LEFT JOIN users u ON p.ownerId=u.id`;
    if (req.user.role !== 'admin') q += ` WHERE p.status='approved'`;
    q += ` ORDER BY p.createdAt DESC`;
    res.json((await db.all(q)).map(formatParking));
  } catch (err) { console.error(err); res.status(500).json({ error: 'Ошибка сервера' }); }
});

app.get('/api/my-parkings', authenticateToken, async (req, res) => {
  try {
    const rows = await db.all(
      `SELECT p.*, u.fullName as ownerName FROM parking_spots p LEFT JOIN users u ON p.ownerId=u.id WHERE p.ownerId=? ORDER BY p.createdAt DESC`,
      [req.user.id]
    );
    res.json(rows.map(formatParking));
  } catch (err) { res.status(500).json({ error: 'Ошибка сервера' }); }
});

app.post('/api/parkings', authenticateToken, upload.array('photos', 5), async (req, res) => {
  try {
    const { role } = req.user;
    if (!['owner','both','admin'].includes(role)) return res.status(403).json({ error: 'Только владельцы могут добавлять парковки' });
    const { address, latitude, longitude, type, pricePerHour, pricePerDay, hasCharging, chargingType, hasSecurity, accessCode, instructions } = req.body;
    if (!address || !latitude || !longitude || !type || !pricePerHour) return res.status(400).json({ error: 'Заполните все обязательные поля' });
    const result = await db.run(
      `INSERT INTO parking_spots (ownerId,address,lat,lng,type,pricePerHour,pricePerDay,hasCharging,chargingType,hasSecurity,accessCode,instructions,status) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [req.user.id, address, parseFloat(latitude), parseFloat(longitude), type, parseFloat(pricePerHour),
       pricePerDay ? parseFloat(pricePerDay) : null, hasCharging==='true'?1:0, chargingType||null,
       hasSecurity==='true'?1:0, accessCode||null, instructions||null, 'pending']
    );
    res.json(formatParking(await db.get('SELECT * FROM parking_spots WHERE id=?', [result.lastID])));
  } catch (err) { console.error(err); res.status(500).json({ error: 'Ошибка сервера' }); }
});

app.post('/api/parkings/:id/approve', authenticateToken, requireAdmin, async (req, res) => {
  try { await db.run(`UPDATE parking_spots SET status='approved',updatedAt=datetime("now") WHERE id=?`, [req.params.id]); res.json({ message: 'Парковка одобрена' }); }
  catch (err) { res.status(500).json({ error: 'Ошибка сервера' }); }
});

app.post('/api/parkings/:id/reject', authenticateToken, requireAdmin, async (req, res) => {
  try { await db.run(`UPDATE parking_spots SET status='rejected',updatedAt=datetime("now") WHERE id=?`, [req.params.id]); res.json({ message: 'Парковка отклонена' }); }
  catch (err) { res.status(500).json({ error: 'Ошибка сервера' }); }
});

app.delete('/api/parkings/:id', authenticateToken, async (req, res) => {
  try {
    const p = await db.get('SELECT * FROM parking_spots WHERE id=?', [req.params.id]);
    if (!p) return res.status(404).json({ error: 'Парковка не найдена' });
    if (p.ownerId !== req.user.id && req.user.role !== 'admin') return res.status(403).json({ error: 'Нет прав' });
    await db.run('DELETE FROM bookings WHERE spotId=?', [req.params.id]);
    await db.run('DELETE FROM parking_spots WHERE id=?', [req.params.id]);
    res.json({ message: 'Парковка удалена' });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Ошибка сервера' }); }
});

// ── BOOKINGS ──────────────────────────────────────────────────
app.post('/api/bookings', authenticateToken, async (req, res) => {
  try {
    const { parkingId, startTime, endTime } = req.body;
    const parking = await db.get('SELECT * FROM parking_spots WHERE id=?', [parkingId]);
    if (!parking) return res.status(404).json({ error: 'Парковка не найдена' });
    const s = new Date(startTime).toISOString(), e = new Date(endTime).toISOString();
    const overlap = await db.get(
      `SELECT id FROM bookings WHERE spotId=? AND paymentStatus!='cancelled' AND ((startTime<=? AND endTime>?) OR (startTime<? AND endTime>=?) OR (startTime>=? AND endTime<=?))`,
      [parkingId, s, s, e, e, s, e]
    );
    if (overlap) return res.status(400).json({ error: 'Это время уже занято' });
    const hours = Math.ceil((new Date(endTime) - new Date(startTime)) / 3600000);
    const ownerAmount = hours * parking.pricePerHour;
    const totalPrice = ownerAmount * 1.15;
    const result = await db.run(
      `INSERT INTO bookings (spotId,driverId,startTime,endTime,totalPrice,ownerAmount,feeAmount,paymentStatus) VALUES (?,?,?,?,?,?,?,?)`,
      [parkingId, req.user.id, s, e, totalPrice, ownerAmount, totalPrice - ownerAmount, 'pending']
    );
    res.json({ booking: await db.get('SELECT * FROM bookings WHERE id=?', [result.lastID]) });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Ошибка сервера' }); }
});

app.get('/api/bookings/my', authenticateToken, async (req, res) => {
  try {
    const rows = await db.all(`SELECT b.*,p.address,p.accessCode as spot_accessCode FROM bookings b JOIN parking_spots p ON b.spotId=p.id WHERE b.driverId=? ORDER BY b.startTime DESC`, [req.user.id]);
    res.json(rows.map(b => ({ ...b, access_code: b.spot_accessCode })));
  } catch (err) { res.status(500).json({ error: 'Ошибка сервера' }); }
});

app.get('/api/bookings/owner', authenticateToken, async (req, res) => {
  try {
    res.json(await db.all(`SELECT b.*,p.address FROM bookings b JOIN parking_spots p ON b.spotId=p.id WHERE p.ownerId=? ORDER BY b.startTime DESC`, [req.user.id]));
  } catch (err) { res.status(500).json({ error: 'Ошибка сервера' }); }
});

app.get('/api/bookings/all', authenticateToken, requireAdmin, async (req, res) => {
  try {
    res.json(await db.all(`SELECT b.*,p.address,p.ownerId,u.phone as ownerPhone FROM bookings b JOIN parking_spots p ON b.spotId=p.id JOIN users u ON p.ownerId=u.id ORDER BY b.startTime DESC`));
  } catch (err) { res.status(500).json({ error: 'Ошибка сервера' }); }
});

app.post('/api/bookings/:id/confirm-payment', authenticateToken, requireAdmin, async (req, res) => {
  try { await db.run(`UPDATE bookings SET paymentStatus='completed',updatedAt=datetime("now") WHERE id=?`, [req.params.id]); res.json({ message: 'Платёж подтверждён' }); }
  catch (err) { res.status(500).json({ error: 'Ошибка сервера' }); }
});

app.post('/api/bookings/:id/reject-payment', authenticateToken, requireAdmin, async (req, res) => {
  try { await db.run(`UPDATE bookings SET paymentStatus='cancelled',updatedAt=datetime("now") WHERE id=?`, [req.params.id]); res.json({ message: 'Платёж отклонён' }); }
  catch (err) { res.status(500).json({ error: 'Ошибка сервера' }); }
});

app.post('/api/payments/kaspi', authenticateToken, async (req, res) => {
  try {
    const { bookingId } = req.body;
    if (!await db.get('SELECT id FROM bookings WHERE id=?', [bookingId])) return res.status(404).json({ error: 'Бронь не найдена' });
    await db.run(`UPDATE bookings SET paymentStatus='held',updatedAt=datetime("now") WHERE id=?`, [bookingId]);
    res.json({ message: 'Информация о платеже отправлена администратору' });
  } catch (err) { res.status(500).json({ error: 'Ошибка сервера' }); }
});

// ── SPA fallback ──────────────────────────────────────────────
app.get('*', (req, res) => {
  res.sendFile(path.join(clientPath, 'index.html'));
});

app.listen(PORT, () => {
  console.log(`Сервер: http://localhost:${PORT}`);
  if (process.env.SMS_REAL !== 'true') console.log('[SMS] DEV-режим — коды выводятся в консоль');
});
