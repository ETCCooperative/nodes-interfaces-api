require('dotenv').config();

const cors = require('cors');
const express = require('express');
const config = require('./config');

const statsRouter = require('./routes/stats');
const operatorsRouter = require('./routes/operators');

const app = express();
const port = process.env.PORT || 3000;

// Enable CORS for all requests
app.use(cors({ origin: config.corsOrigin }));

// Install routers
app.use(statsRouter);
app.use(operatorsRouter);

// Start the server
app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});
