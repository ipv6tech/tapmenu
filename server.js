const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const session = require('express-session');
const lusca = require('lusca');
const { rateLimit } = require('express-rate-limit');
const path = require('path');
const { getSessionSecret } = require('./src/security');

const { initDb, UPLOADS_DIR, DB_PATH: DATA_FILE_HINT } = require('./src/db');
const tapsRouter = require('./src/api/taps');
const authRouter = require('./src/api/auth');
const qrRouter = require('./src/api/qr');
const brewfatherRouter = require('./src/api/brewfather');
const beersRouter = require('./src/api/beers');

const PORT = process.env.PORT || 3000;

async function start() {
  await initDb();
  console.log('✅ Database initialized');

  const app = express();
  if (process.env.TRUST_PROXY) app.set('trust proxy', process.env.TRUST_PROXY === 'true' ? 1 : process.env.TRUST_PROXY);

  // The single-file frontend uses inline scripts/handlers and Google Fonts; user-supplied
  // image URLs (logos, tap images) may point at any http(s) host.
  app.use(helmet({
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", "'unsafe-inline'"],
        scriptSrcAttr: ["'unsafe-inline'"],
        styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
        fontSrc: ["'self'", 'https://fonts.gstatic.com'],
        imgSrc: ["'self'", 'data:', 'https:', 'http:'],
        connectSrc: ["'self'"],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'"],
        frameAncestors: ["'self'"]
      }
    }
  }));
  app.use(cors());
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));

  // Global request throttle (per IP); stricter limits are applied on sensitive routers.
  app.use(rateLimit({ windowMs: 15 * 60 * 1000, limit: 1000, standardHeaders: true, legacyHeaders: false }));

  app.use(session({
    secret: getSessionSecret(path.dirname(DATA_FILE_HINT)),
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: 'lax',
      // Set COOKIE_SECURE=true when served over HTTPS (and TRUST_PROXY=true behind a proxy)
      secure: process.env.COOKIE_SECURE === 'true',
      maxAge: 7 * 24 * 60 * 60 * 1000
    }
  }));

  // CSRF protection for state-changing requests (token synced with the session,
  // sent by the frontend in the X-CSRF-Token header).
  app.use(lusca.csrf({ header: 'x-csrf-token' }));
  app.get('/api/csrf-token', (req, res) => res.json({ token: res.locals._csrf }));

  app.use('/api/taps', tapsRouter);
  app.use('/api/auth', authRouter);
  app.use('/api/qr', qrRouter);
  app.use('/api/brewfather', brewfatherRouter);
  app.use('/api/beers', beersRouter);

  // Uploads are user-supplied: never let them execute script in the app's origin
  app.use('/uploads', (req, res, next) => {
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('Content-Security-Policy', "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox");
    next();
  }, express.static(UPLOADS_DIR));
  app.use(express.static(path.join(__dirname, 'public')));
  app.get('/*splat', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`🍺 Tap Menu running at http://localhost:${PORT}`);
    console.log(`   Admin panel: http://localhost:${PORT}/admin`);
  });
}

start().catch(console.error);
