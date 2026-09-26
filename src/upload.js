const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { UPLOADS_DIR } = require('./db');

if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOADS_DIR),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase() || '.png';
    cb(null, `img_${Date.now()}_${Math.round(Math.random() * 1e9)}${ext}`);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 2 * 1024 * 1024 }, // 2MB
  fileFilter: (req, file, cb) => {
    if (/^image\/(png|jpeg|gif|svg\+xml|webp)$/.test(file.mimetype)) cb(null, true);
    else cb(new Error('Only image files are allowed'));
  }
});

module.exports = { upload, UPLOADS_DIR };
