require('dotenv').config();

const cors = require('cors');
const express = require('express');
const compression = require('compression');
const config = require('./config');

const peersRouter = require('./routes/peers');
const statsRouter = require('./routes/stats');
const operatorsRouter = require('./routes/operators');

const app = express();
const host = process.env.HOST || 'localhost';
const port = process.env.PORT || 3000;

// Enable CORS for all requests
app.use(cors({ origin: config.corsOrigin }));

// Enable compression on all responses
app.use(compression());

// Install routers
app.use(peersRouter);
app.use(statsRouter);
app.use(operatorsRouter);

// Start the server
app.listen(port, host, () => {
  console.log(`Server running on port ${port}`);
});
