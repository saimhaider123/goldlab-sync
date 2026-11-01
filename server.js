// Gold Lab Pro — sync server.
//
// Every device (Windows PC, Android phone) keeps its own offline SQLite
// database and syncs through this server when internet is available.
// One "shop" = one sync key shared by all devices of that customer.
//
// Env:
//   MONGODB_URI   MongoDB Atlas connection string
//   ADMIN_TOKEN   secret used only by the developer to create shops
//   PORT          (Render sets this)

const crypto = require('crypto');
const express = require('express');
const { MongoClient } = require('mongodb');

const PORT = process.env.PORT || 8080;
const MONGODB_URI = process.env.MONGODB_URI;
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || '';
const PAGE = 1000; // records per pull
const TABLES = new Set(['customers', 'entries', 'lab_tests', 'settings']);

if (!MONGODB_URI) {
  console.error('MONGODB_URI is not set');
  process.exit(1);
}

const client = new MongoClient(MONGODB_URI);
let shops;
let records;

const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const safeEqual = (a, b) => {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '25mb' }));

app.get('/', (_req, res) => res.json({ ok: true, service: 'goldlab-sync', time: new Date().toISOString() }));

// ───────────────────────── Admin (developer only) ─────────────────────────

function admin(req, res, next) {
  const t = req.get('x-admin-token') || '';
  if (!ADMIN_TOKEN || !safeEqual(t, ADMIN_TOKEN)) return res.status(401).json({ error: 'unauthorized' });
  next();
}

/** Creates a shop and returns its sync key (shown once — keep it safe). */
app.post('/admin/shops', admin, async (req, res) => {
  const name = String((req.body && req.body.name) || 'Shop').slice(0, 80);
  const id = 'GLP' + crypto.randomBytes(4).toString('hex').toUpperCase();
  const secret = crypto.randomBytes(24).toString('base64url');
  await shops.insertOne({ _id: id, name, secretHash: sha(secret), active: true, seq: 0, createdAt: new Date() });
  res.json({ shop: id, name, syncKey: `${id}.${secret}` });
});

app.get('/admin/shops', admin, async (_req, res) => {
  const list = await shops.find({}, { projection: { secretHash: 0 } }).sort({ createdAt: -1 }).toArray();
  res.json(list);
});

/** Blocks (active=false) or unblocks a shop. */
app.post('/admin/shops/:id/active', admin, async (req, res) => {
  const active = !!(req.body && req.body.active);
  const r = await shops.updateOne({ _id: req.params.id }, { $set: { active } });
  res.json({ ok: r.matchedCount === 1, active });
});

// ───────────────────────── Sync ─────────────────────────

async function auth(req, res, next) {
  try {
    const key = req.get('x-sync-key') || '';
    const dot = key.indexOf('.');
    if (dot < 1) return res.status(401).json({ error: 'Invalid sync key' });
    const shop = await shops.findOne({ _id: key.slice(0, dot) });
    if (!shop || !safeEqual(shop.secretHash, sha(key.slice(dot + 1)))) {
      return res.status(401).json({ error: 'Invalid sync key' });
    }
    if (!shop.active) return res.status(403).json({ error: 'Sync is disabled for this shop. Contact the vendor.' });
    req.shop = shop;
    next();
  } catch (e) {
    next(e);
  }
}

/**
 * One round trip: the device sends its local changes and receives everything
 * changed on the server after its cursor.
 *
 * body: { device, since, changes: [{ t, uid, u, d, data }] }
 *   t = table, uid = row id shared by all devices, u = updated-at (ms),
 *   d = deleted (true/false), data = row values
 * reply: { changes: [...], cursor, more }
 */
app.post('/sync', auth, async (req, res, next) => {
  try {
    const shopId = req.shop._id;
    const device = String((req.body && req.body.device) || '').slice(0, 64);
    const since = Number((req.body && req.body.since) || 0);
    const incoming = Array.isArray(req.body && req.body.changes) ? req.body.changes : [];
    const valid = incoming.filter(
      (c) => c && TABLES.has(c.t) && typeof c.uid === 'string' && c.uid.length > 0 && c.uid.length <= 100,
    );

    if (valid.length) {
      // Reserve one sequence number per change.
      const r = await shops.findOneAndUpdate(
        { _id: shopId },
        { $inc: { seq: valid.length } },
        { returnDocument: 'after' },
      );
      const doc = r && r.value !== undefined ? r.value : r;
      let seq = doc.seq - valid.length;
      const ops = valid.map((c) => {
        seq += 1;
        const u = Number(c.u) || Date.now();
        return {
          updateOne: {
            // Last write wins: only replace when the incoming change is not older.
            filter: { shop: shopId, t: c.t, uid: c.uid, u: { $lte: u } },
            update: {
              $set: { d: !!c.d, data: c.d ? null : c.data || {}, u, seq, dev: device, at: new Date() },
            },
            upsert: true,
          },
        };
      });
      try {
        await records.bulkWrite(ops, { ordered: false });
      } catch (e) {
        // Duplicate key = the server already has a newer version of that row. Ignore.
        const errs = (e && e.writeErrors) || [];
        if (!errs.length || errs.some((w) => (w.code || (w.err && w.err.code)) !== 11000)) throw e;
      }
    }

    const docs = await records
      .find({ shop: shopId, seq: { $gt: since } }, { projection: { _id: 0, t: 1, uid: 1, u: 1, d: 1, data: 1, dev: 1, seq: 1 } })
      .sort({ seq: 1 })
      .limit(PAGE)
      .toArray();
    const cursor = docs.length ? docs[docs.length - 1].seq : since;
    res.json({
      changes: docs.map((x) => ({ t: x.t, uid: x.uid, u: x.u, d: x.d, data: x.data, dev: x.dev })),
      cursor,
      more: docs.length === PAGE,
    });
  } catch (e) {
    next(e);
  }
});

app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: 'Server error' });
});

(async () => {
  await client.connect();
  const db = client.db(process.env.DB_NAME || 'goldlab_sync');
  shops = db.collection('shops');
  records = db.collection('records');
  await records.createIndex({ shop: 1, t: 1, uid: 1 }, { unique: true });
  await records.createIndex({ shop: 1, seq: 1 });
  app.listen(PORT, () => console.log(`goldlab-sync listening on ${PORT}`));
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
