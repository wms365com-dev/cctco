require('dotenv').config();

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const multer = require('multer');
const { Pool } = require('pg');
const helmet = require('helmet');
const compression = require('compression');
const morgan = require('morgan');

const app = express();
const port = process.env.PORT || 3000;
const uploadDir = process.env.UPLOAD_DIR || path.join(__dirname, 'data', 'uploads');
const hasDatabase = Boolean(process.env.DATABASE_URL);

fs.mkdirSync(uploadDir, { recursive: true });

const pool = hasDatabase
  ? new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: process.env.DATABASE_URL.includes('localhost') ? false : { rejectUnauthorized: false }
    })
  : null;

app.use(helmet({ contentSecurityPolicy: false }));
app.use(compression());
app.use(morgan('tiny'));
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));
function isMobileUserAgent(userAgent = '') {
  return /Android|iPhone|iPad|iPod|IEMobile|Opera Mini|Mobile/i.test(userAgent);
}

app.use((req, res, next) => {
  if (!['GET', 'HEAD'].includes(req.method) || req.path.startsWith('/api/')) {
    return next();
  }

  const mobile = isMobileUserAgent(req.get('user-agent'));
  const pathName = req.path.toLowerCase();
  const suffix = req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '';

  if (mobile && (pathName === '/' || pathName === '/index.html')) {
    return res.redirect(302, '/mobile.html' + suffix);
  }
  if (mobile && pathName === '/apply.html') {
    return res.redirect(302, '/apply-mobile.html' + suffix);
  }
  next();
});

app.use(express.static(__dirname));

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => {
    const safeExt = path.extname(file.originalname).toLowerCase().replace(/[^a-z0-9.]/g, '') || '.bin';
    cb(null, `${Date.now()}-${crypto.randomUUID()}${safeExt}`);
  }
});

const upload = multer({
  storage,
  limits: {
    fileSize: 10 * 1024 * 1024,
    files: 6
  },
  fileFilter: (req, file, cb) => {
    const allowed = new Set([
      'application/pdf',
      'image/jpeg',
      'image/png',
      'image/webp',
      'application/msword',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    ]);
    cb(null, allowed.has(file.mimetype));
  }
});

async function migrate() {
  if (!pool) {
    console.warn('DATABASE_URL is not set. API write endpoints will return 503 until PostgreSQL is configured.');
    return;
  }

  await pool.query(`
    CREATE TABLE IF NOT EXISTS quote_requests (
      id BIGSERIAL PRIMARY KEY,
      full_name TEXT NOT NULL,
      email TEXT NOT NULL,
      phone TEXT,
      company TEXT,
      facility_type TEXT,
      city TEXT,
      square_feet TEXT,
      frequency TEXT,
      message TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS worker_applications (
      id BIGSERIAL PRIMARY KEY,
      full_name TEXT NOT NULL,
      email TEXT NOT NULL,
      phone TEXT NOT NULL,
      city TEXT,
      work_areas TEXT,
      availability TEXT,
      experience TEXT,
      vehicle_type TEXT,
      can_work_nights BOOLEAN DEFAULT FALSE,
      can_work_weekends BOOLEAN DEFAULT FALSE,
      has_cleaning_experience BOOLEAN DEFAULT FALSE,
      has_work_authorization BOOLEAN DEFAULT FALSE,
      sin_last_three TEXT,
      notes TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS application_files (
      id BIGSERIAL PRIMARY KEY,
      application_id BIGINT NOT NULL REFERENCES worker_applications(id) ON DELETE CASCADE,
      field_name TEXT NOT NULL,
      original_name TEXT NOT NULL,
      stored_name TEXT NOT NULL,
      mime_type TEXT NOT NULL,
      size_bytes BIGINT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
}

function requireDatabase(req, res, next) {
  if (!pool) {
    return res.status(503).json({
      ok: false,
      error: 'Database is not configured. Add a Railway PostgreSQL service and set DATABASE_URL.'
    });
  }
  next();
}

function requireAdmin(req, res, next) {
  const token = req.get('x-admin-token') || req.query.token;
  if (!process.env.ADMIN_TOKEN || token !== process.env.ADMIN_TOKEN) {
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }
  next();
}

function bool(value) {
  return value === 'on' || value === 'true' || value === true;
}

app.get('/api/health', (req, res) => {
  res.json({ ok: true, database: hasDatabase, uploadDir });
});

app.post('/api/quotes', requireDatabase, async (req, res, next) => {
  try {
    const { name, email, phone, company, facility, city, squareFeet, frequency, message } = req.body;
    if (!name || !email) {
      return res.status(400).json({ ok: false, error: 'Name and email are required.' });
    }

    const result = await pool.query(
      `INSERT INTO quote_requests
       (full_name, email, phone, company, facility_type, city, square_feet, frequency, message)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       RETURNING id, created_at`,
      [name, email, phone || null, company || null, facility || null, city || null, squareFeet || null, frequency || null, message || null]
    );

    res.status(201).json({ ok: true, id: result.rows[0].id, createdAt: result.rows[0].created_at });
  } catch (error) {
    next(error);
  }
});

app.post(
  '/api/applications',
  requireDatabase,
  upload.fields([
    { name: 'resume', maxCount: 1 },
    { name: 'idDocument', maxCount: 1 },
    { name: 'sinDocument', maxCount: 1 },
    { name: 'certifications', maxCount: 3 }
  ]),
  async (req, res, next) => {
    const client = await pool.connect();
    try {
      const {
        fullName,
        email,
        phone,
        city,
        workAreas,
        availability,
        experience,
        vehicleType,
        sinLastThree,
        notes
      } = req.body;

      if (!fullName || !email || !phone) {
        return res.status(400).json({ ok: false, error: 'Full name, email, and phone are required.' });
      }

      await client.query('BEGIN');
      const appResult = await client.query(
        `INSERT INTO worker_applications
         (full_name, email, phone, city, work_areas, availability, experience, vehicle_type,
          can_work_nights, can_work_weekends, has_cleaning_experience, has_work_authorization,
          sin_last_three, notes)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
         RETURNING id, created_at`,
        [
          fullName,
          email,
          phone,
          city || null,
          workAreas || null,
          availability || null,
          experience || null,
          vehicleType || null,
          bool(req.body.canWorkNights),
          bool(req.body.canWorkWeekends),
          bool(req.body.hasCleaningExperience),
          bool(req.body.hasWorkAuthorization),
          sinLastThree || null,
          notes || null
        ]
      );

      const applicationId = appResult.rows[0].id;
      const files = Object.values(req.files || {}).flat();
      for (const file of files) {
        await client.query(
          `INSERT INTO application_files
           (application_id, field_name, original_name, stored_name, mime_type, size_bytes)
           VALUES ($1,$2,$3,$4,$5,$6)`,
          [applicationId, file.fieldname, file.originalname, file.filename, file.mimetype, file.size]
        );
      }

      await client.query('COMMIT');
      res.status(201).json({ ok: true, id: applicationId, createdAt: appResult.rows[0].created_at });
    } catch (error) {
      await client.query('ROLLBACK');
      next(error);
    } finally {
      client.release();
    }
  }
);

app.get('/api/admin/quotes', requireDatabase, requireAdmin, async (req, res, next) => {
  try {
    const result = await pool.query('SELECT * FROM quote_requests ORDER BY created_at DESC LIMIT 200');
    res.json({ ok: true, quotes: result.rows });
  } catch (error) {
    next(error);
  }
});

app.get('/api/admin/applications', requireDatabase, requireAdmin, async (req, res, next) => {
  try {
    const result = await pool.query(`
      SELECT a.*,
        COALESCE(json_agg(json_build_object(
          'id', f.id,
          'fieldName', f.field_name,
          'originalName', f.original_name,
          'storedName', f.stored_name,
          'mimeType', f.mime_type,
          'sizeBytes', f.size_bytes,
          'createdAt', f.created_at
        )) FILTER (WHERE f.id IS NOT NULL), '[]') AS files
      FROM worker_applications a
      LEFT JOIN application_files f ON f.application_id = a.id
      GROUP BY a.id
      ORDER BY a.created_at DESC
      LIMIT 200
    `);
    res.json({ ok: true, applications: result.rows });
  } catch (error) {
    next(error);
  }
});

app.use((error, req, res, next) => {
  console.error(error);
  if (error instanceof multer.MulterError) {
    return res.status(400).json({ ok: false, error: error.message });
  }
  res.status(500).json({ ok: false, error: 'Something went wrong. Please try again.' });
});

migrate()
  .then(() => app.listen(port, () => console.log(`Commercial cleaning site listening on ${port}`)))
  .catch((error) => {
    console.error('Failed to start server', error);
    process.exit(1);
  });
