const express = require('express');
const router = express.Router();
const axios = require('axios');

router.post('/ask', async (req, res) => {
  try {
    const { question } = req.body;

    if (!question) {
      return res.status(400).json({ error: 'Question required' });
    }

    // Mock AI response - Replace with actual OpenAI call
    const response = {
      success: true,
      answer: `REDTECH AI: This is a mock response to your question: "${question}". In production, this would use the OpenAI API for intelligent responses.`
    };

    res.json(response);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
