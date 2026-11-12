// firesight-backend/app.js
const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
const connectDB = require('./db'); 
const { startWildfireScheduler } = require('./services/wildfireScheduler');

dotenv.config();

const app = express();

// Allow local development requests.
app.use(cors());
app.use(express.json());

// TODO: restore production origin support before next Render deploy - see PROJECT_MAP.md.
// app.use(cors({
//   origin: process.env.FRONTEND_ORIGIN
// }));

app.get('/', (req, res) => {
  res.send('FireSight Backend is running');
});


// Import API routes
const fireDataRoutes = require('./routes/fireData'); // Fire Data
const weatherRoutes = require('./routes/weather'); // Ensure this is imported
const topographyRoutes = require('./routes/topography'); // Topography Data
const humanFactorsRoutes = require('./routes/humanFactors'); // Human Factors Data
const predictFireSpreadRouter = require('./routes/predictFireSpread');
const detectionPolygonRouter = require('./routes/detectionPolygon');

app.use('/api', fireDataRoutes);
app.use('/api/weather', weatherRoutes);
app.use('/api/topography', topographyRoutes);
app.use('/api/human-factors', humanFactorsRoutes);
app.use('/api/predict-fire-spread', predictFireSpreadRouter);
app.use('/api/detection-polygon', detectionPolygonRouter);

// Error handling middleware
app.use((err, req, res, next) => {
  console.error("🔥 Server Error:", err.message);
  res.status(500).json({ error: "Internal Server Error", details: err.message });
});

const PORT = process.env.PORT || 5000;

async function startServer() {
  await connectDB();
  const server = app.listen(PORT, () => {
    console.log(`🚀 Server started on port ${PORT}`);
  });
  const scheduler = startWildfireScheduler();
  const shutdown = () => {
    scheduler?.stop();
    server.close(() => process.exit(0));
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
  return server;
}

if (require.main === module) startServer();

module.exports = { app, startServer };
