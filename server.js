const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const session = require('express-session');
const path = require('path');

const { initDb, UPLOADS_DIR } = require('./src/db');
const tapsRouter = require('./src/api/taps');
const authRouter = require('./src/api/auth');
const qrRouter = require('./src/api/qr');
const brewfatherRouter = require('./src/api/brewfather');

const PORT = process.env.PORT || 3000;

async function start() {
  await initDb();
  console.log('✅ Database initialized');

  const app = express();

  app.use(helmet({ contentSecurityPolicy: false }));
  app.use(cors());
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));

  app.use(session({
    secret: process.env.SESSION_SECRET || 'taproom-secret-change-me-in-production',
    resave: false,
    saveUninitialized: false,
    cookie: { secure: false, maxAge: 7 * 24 * 60 * 60 * 1000 }
  }));

  app.use('/api/taps', tapsRouter);
  app.use('/api/auth', authRouter);
  app.use('/api/qr', qrRouter);
  app.use('/api/brewfather', brewfatherRouter);

  app.use('/uploads', express.static(UPLOADS_DIR));
  app.use(express.static(path.join(__dirname, 'public')));
  app.get('/*splat', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`🍺 Taproom running at http://localhost:${PORT}`);
    console.log(`   Admin panel: http://localhost:${PORT}/admin`);
  });
}

start().catch(console.error);
