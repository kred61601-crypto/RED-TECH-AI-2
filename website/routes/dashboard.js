const express = require('express');
const router = express.Router();

// Mock data
const dashboardData = {
  balance: 12450.50,
  activeBots: 24,
  messages: 14200,
  campaigns: 8,
  uptime: 99.9
};

router.get('/stats', (req, res) => {
  res.json({
    success: true,
    data: dashboardData
  });
});

router.get('/bots', (req, res) => {
  res.json({
    success: true,
    bots: [
      { id: 1, name: 'Customer Support Bot', status: 'active', messages: 1200 },
      { id: 2, name: 'Sales Bot', status: 'active', messages: 3400 },
      { id: 3, name: 'Lead Generator', status: 'inactive', messages: 0 }
    ]
  });
});

module.exports = router;
