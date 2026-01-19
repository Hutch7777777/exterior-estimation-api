import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import sidingRoutes from './routes/siding';
import webhookRoutes from './routes/webhook';
import { isDatabaseConfigured, testConnection } from './services/database';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: '10mb' })); // Increase limit for HOVER data

// Health check
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    version: '4.0.0',
    trade: 'siding',
    phase: 'Phase 4 - n8n Webhook Integration',
    database: isDatabaseConfigured() ? 'configured' : 'not configured',
    endpoints: {
      webhook: '/webhook/siding-estimator',
      api: '/api/v1/siding/calculate-priced'
    }
  });
});

// API routes (Phase 1-3)
app.use('/api/v1/siding', sidingRoutes);

// Webhook routes (Phase 4 - n8n compatible)
app.use('/webhook', webhookRoutes);

async function startServer() {
  // Check database status
  const dbConfigured = isDatabaseConfigured();
  let dbConnected = false;

  if (dbConfigured) {
    dbConnected = await testConnection();
  }

  app.listen(PORT, () => {
    console.log(`🚀 Siding Calculation API v4.0 running on port ${PORT}`);
    console.log('');
    console.log('📊 Database Status:');
    if (!dbConfigured) {
      console.log('   ⚠️  Not configured - using fallback pricing');
    } else if (dbConnected) {
      console.log('   ✅ Connected to Supabase');
    } else {
      console.log('   ❌ Configured but connection failed');
    }
    console.log('');
    console.log('📌 API Endpoints:');
    console.log(`   Health:       http://localhost:${PORT}/health`);
    console.log(`   Calculate:    POST http://localhost:${PORT}/api/v1/siding/calculate`);
    console.log(`   With Pricing: POST http://localhost:${PORT}/api/v1/siding/calculate-priced`);
    console.log(`   DB Status:    http://localhost:${PORT}/api/v1/siding/db-status`);
    console.log('');
    console.log('🔗 n8n Webhook Endpoints:');
    console.log(`   Siding:       POST http://localhost:${PORT}/webhook/siding-estimator`);
    console.log(`   Test:         POST http://localhost:${PORT}/webhook/test`);
    console.log(`   Health:       GET  http://localhost:${PORT}/webhook/health`);
  });
}

startServer();

export default app;
