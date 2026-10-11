const express = require('express');
const router = express.Router();

const services = [
  {
    id: 1,
    name: 'WhatsApp Bot Hosting',
    description: 'Launch and manage WhatsApp bots with ease. No coding required.',
    price: '$25/mo',
    icon: '💬'
  },
  {
    id: 2,
    name: 'Social Media Boosting',
    description: 'Increase followers, engagement, and reach across all platforms.',
    price: '$35/mo',
    icon: '📈'
  },
  {
    id: 3,
    name: 'VPS Hosting',
    description: 'Secure, scalable hosting for your business applications.',
    price: '$50/mo',
    icon: '🖥️'
  },
  {
    id: 4,
    name: 'AI Integration',
    description: 'Powered by OpenAI for intelligent, human-like conversations.',
    price: '$15/mo',
    icon: '🤖'
  }
];

router.get('/', (req, res) => {
  res.json({ services });
});

router.get('/:id', (req, res) => {
  const service = services.find(s => s.id === parseInt(req.params.id));
  if (!service) {
    return res.status(404).json({ error: 'Service not found' });
  }
  res.json(service);
});

module.exports = router;
