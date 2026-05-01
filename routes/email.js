const express = require('express');
const router = express.Router();
const { getEmails, sendEmail } = require('../services/email');

// Get emails
router.get('/', async (req, res) => {
  try {
    const emails = await getEmails();
    res.json(emails);
  } catch (error) {
    console.error('Error fetching emails:', error);
    res.status(500).json({ error: 'Failed to fetch emails' });
  }
});

// Send email
router.post('/send', async (req, res) => {
  try {
    const { to, subject, body } = req.body;
    await sendEmail({ to, subject, body });
    res.json({ success: true, message: 'Email sent successfully' });
  } catch (error) {
    console.error('Error sending email:', error);
    res.status(500).json({ error: 'Failed to send email' });
  }
});

module.exports = router;
