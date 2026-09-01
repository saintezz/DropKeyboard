import express from 'express';
import { WebSocketServer } from 'ws';
import cors from 'cors';
import fs from 'fs';
import { randomUUID } from 'crypto';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const port = process.env.PORT || 3000;

// Настройка для Telegram Mini App
app.use(cors({
  origin: ['https://t.me', 'https://web.telegram.org', 'https://your-app.onrender.com'],
  credentials: true
}));
app.use(express.json());

// Раздача статики из папки public
app.use(express.static('public'));

// ===== БАЗА ДАННЫХ =====
const DB_FILE = path.join(__dirname, 'server.json');

let db = {
  users: {},
  drops: [],
  promo: {}
};

function loadDB() {
  try {
    if (fs.existsSync(DB_FILE)) {
      const data = fs.readFileSync(DB_FILE, 'utf8');
      db = JSON.parse(data);
    }
  } catch (e) {
    console.warn('Не удалось загрузить БД, создана новая');
  }
  if (!db.promo || Object.keys(db.promo).length === 0) {
    db.promo = {
      'DEMO2025': { reward: 25, used: false },
      'CASESPINNER': { reward: 50, used: false },
      'HELLO': { reward: 15, used: false },
      'TGSTART': { reward: 30, used: false }
    };
  }
  saveDB();
}

function saveDB() {
  try {
    fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
  } catch (e) {
    console.error('Ошибка сохранения БД:', e);
  }
}

loadDB();

// ===== ВСПОМОГАТЕЛЬНЫЕ =====
function getOrCreateUser(id, username) {
  if (!db.users[id]) {
    db.users[id] = {
      id,
      username: username || 'user_' + id.slice(0, 6),
      balance: 100,
      wins: 0,
      spins: 0,
      inventory: [],
      createdAt: Date.now()
    };
    saveDB();
  }
  if (username && db.users[id].username !== username) {
    db.users[id].username = username;
    saveDB();
  }
  return db.users[id];
}

function addDrop(username, item) {
  db.drops.unshift({ username, item, timestamp: Date.now() });
  if (db.drops.length > 200) db.drops.length = 200;
  saveDB();
}

function getWeighted(items) {
  const valid = items.filter(x => x.chance > 0);
  let r = Math.random() * 100;
  for (const item of valid) {
    if (r < item.chance) return item;
    r -= item.chance;
  }
  return valid[valid.length - 1] || items[0];
}

// ===== ДАННЫЕ КЕЙСОВ =====
const IMG_DOMINUS = 'https://github.com/saintezz/DropKeyboard/blob/main/c8e14aec-b504-4d87-915a-dee1c2e706b0.jpg?raw=true';

const CASE_DATA = {
  secret: {
    cost: 10,
    items: [
      { name: 'Golden Mask', chance: 67, img: null, emoji: 'X' },
      { name: 'Candy Dominus', chance: 23, img: IMG_DOMINUS, emoji: null },
      { name: 'Canada', chance: 10, img: null, emoji: 'X' }
    ]
  },
  common: {
    cost: 5,
    items: [
      { name: 'Candy Crown', chance: 90, img: null, emoji: 'X' },
      { name: 'Shell Crown', chance: 10, img: null, emoji: 'X' }
    ]
  }
};

// ===== REST API =====
app.get('/api/state', (req, res) => {
  const id = req.query.id || randomUUID();
  const username = req.query.username || 'user';
  const user = getOrCreateUser(id, username);
  const recent = db.drops.slice(0, 50);
  res.json({ user, drops: recent });
});

app.post('/api/spin', (req, res) => {
  const { id, username, caseName } = req.body;
  if (!id || !caseName) {
    return res.status(400).json({ error: 'Неверный запрос' });
  }

  const user = getOrCreateUser(id, username);
  const caseData = CASE_DATA[caseName];
  if (!caseData) {
    return res.status(400).json({ error: 'Кейс не найден' });
  }

  if (user.balance < caseData.cost) {
    return res.status(400).json({ error: 'Недостаточно DEMO' });
  }

  const winner = getWeighted(caseData.items);
  user.balance -= caseData.cost;
  user.spins += 1;
  user.wins += 1;
  user.inventory.push({ ...winner, wonAt: Date.now() });

  addDrop(user.username, winner);
  saveDB();

  res.json({
    winner,
    user: {
      id: user.id,
      username: user.username,
      balance: user.balance,
      wins: user.wins,
      spins: user.spins,
      inventory: user.inventory
    }
  });
});

app.post('/api/promo', (req, res) => {
  const { id, username, code } = req.body;
  if (!id || !code) {
    return res.status(400).json({ error: 'Неверный запрос' });
  }

  const user = getOrCreateUser(id, username);
  const promo = db.promo[code];

  if (!promo) {
    return res.status(400).json({ error: 'Промокод не найден' });
  }

  if (promo.used) {
    return res.status(400).json({ error: 'Промокод уже использован' });
  }

  promo.used = true;
  user.balance += promo.reward || 25;
  saveDB();

  res.json({
    message: `Промокод активирован! +${promo.reward || 25} DEMO`,
    user: {
      id: user.id,
      username: user.username,
      balance: user.balance,
      wins: user.wins,
      spins: user.spins,
      inventory: user.inventory
    }
  });
});

// ===== WebSocket =====
const server = app.listen(port, '0.0.0.0', () => {
  console.log(`✅ Сервер запущен на порту ${port}`);
});

const wss = new WebSocketServer({ server });

wss.on('connection', (ws) => {
  ws.send(JSON.stringify({
    type: 'drops',
    drops: db.drops.slice(0, 30)
  }));

  const broadcast = (data) => {
    wss.clients.forEach(client => {
      if (client.readyState === 1) {
        client.send(JSON.stringify(data));
      }
    });
  };

  const originalSave = saveDB;
  saveDB = function() {
    originalSave();
    if (db.drops.length > 0) {
      const last = db.drops[0];
      broadcast({
        type: 'drop',
        drop: last
      });
    }
  };

  ws.on('close', () => {
    if (wss.clients.size === 0) {
      saveDB = originalSave;
    }
  });
});

// ===== Админка =====
app.get('/admin', (req, res) => {
  res.json({
    users: Object.keys(db.users).length,
    drops: db.drops.length,
    promo: db.promo,
    uptime: process.uptime()
  });
});

// ===== Health check для Render =====
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok' });
});

setInterval(saveDB, 30000);
