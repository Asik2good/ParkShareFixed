# ParkShare — Запуск и деплой

## Локальный запуск

```bash
cd server
cp .env.example .env        # Создай файл с настройками
npm install
npm run dev                  # Запустит nodemon на http://localhost:3000
```

В `.env` оставь `SMS_REAL=false` — код будет выводиться в консоль.

---

## Деплой на Render

### Шаг 1 — Подготовь репозиторий

Убедись что в `.gitignore` есть строки:
```
node_modules/
.env
uploads/
*.sqlite
```

Запушь проект на GitHub.

### Шаг 2 — Создай Web Service на Render

1. Зайди на [render.com](https://render.com) и нажми **New → Web Service**
2. Подключи свой GitHub репозиторий
3. Заполни настройки:
   - **Root Directory:** `server`
   - **Build Command:** `npm install`
   - **Start Command:** `node server.js`
   - **Instance Type:** Free (или Starter за $7/мес — не "засыпает")

### Шаг 3 — Добавь Persistent Disk

> ⚠️ Обязательно! Без диска SQLite и загруженные фото удалятся при каждом деплое.

1. В настройках сервиса → **Disks** → **Add Disk**
2. **Name:** `parkshare-data`
3. **Mount Path:** `/opt/render/project/src/server`
4. **Size:** 1 GB

### Шаг 4 — Переменные окружения

В разделе **Environment** добавь:

| Ключ | Значение |
|------|---------|
| `JWT_SECRET` | Случайная строка (нажми Generate) |
| `SMS_REAL` | `true` |
| `TWILIO_ACCOUNT_SID` | Из консоли Twilio |
| `TWILIO_AUTH_TOKEN` | Из консоли Twilio |
| `TWILIO_PHONE_NUMBER` | Твой Twilio-номер (формат `+12345678900`) |

### Шаг 5 — Deploy

Нажми **Create Web Service**. Render соберёт и запустит приложение.
Твой сайт будет доступен по адресу `https://parkshare.onrender.com` (имя выбираешь сам).

---

## Настройка Twilio

1. Зарегистрируйся на [twilio.com](https://www.twilio.com)
2. Пройди верификацию — получишь ~15$ на триал
3. На главной странице Console скопируй:
   - **Account SID**
   - **Auth Token**
4. Купи номер: **Phone Numbers → Buy a Number**
   - Выбери номер с возможностью SMS
   - Стоимость ~1$/мес
5. Для триала: в разделе **Verified Caller IDs** добавь свой казахстанский номер для тестирования

> **Важно для Казахстана:** на триал-аккаунте можно слать SMS только на верифицированные номера. Для production нужно пополнить баланс (от 20$) и убрать ограничение Trial.

---

## Назначить администратора

После первого входа в систему выполни в консоли Render (или локально):

```bash
# В папке server
node -e "
const db = require('./database');
// Замени номер на свой
db.run(\"UPDATE users SET role='admin' WHERE phone='+77001234567'\")
  .then(() => { console.log('Готово'); process.exit(0); });
"
```

---

## Структура проекта

```
parkshare/
├── client/
│   └── index.html          # Фронтенд (всё в одном файле)
├── server/
│   ├── server.js           # Express сервер + API
│   ├── database.js         # SQLite обёртка
│   ├── package.json
│   ├── .env.example        # Шаблон переменных окружения
│   └── .gitignore
├── render.yaml             # Конфиг для Render
└── DEPLOY.md               # Этот файл
```
