import 'dotenv/config';
import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import routes from './routes.js';

const app = express();
app.set('trust proxy', 1);
app.use(helmet());
app.get('/health', (_q, r) => r.send('ok'));
app.use(cors({ origin: (process.env.CLIENT_ORIGIN || '').split(',') }));
app.use(express.json({ limit: '10kb' }));
app.use('/api', rateLimit({ windowMs: 60_000, limit: 90 }), routes);
app.use((err, _req, res, _next) => {
  if (!err.expose) console.error(err);
  res.status(err.status || 500).json({ error: err.expose ? err.message : 'Something went wrong' });
});
app.listen(process.env.PORT || 4000, () => console.log('Workon API ready'));
