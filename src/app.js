import express from 'express';
import router from './routes.js';

const app = express();

// Standard middleware
app.use(express.json());
app.use(express.static('public'));

// Enable trust proxy so rate limiter gets correct client IP in proxy/docker environment
app.set('trust proxy', true);

// Mount API routes
app.use(router);

// Global Error Handler
app.use((err, req, res, next) => {
  console.error('Unhandled server error:', err);
  res.status(500).json({ error: 'Internal Server Error' });
});

export default app;
