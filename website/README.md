# REDTECH - WhatsApp Bot & Automation SaaS Platform

🚀 **The complete platform for WhatsApp bots, automation, and digital services**

## Features

- ✅ WhatsApp Bot Hosting
- ✅ AI-Powered Conversations (OpenAI Integration)
- ✅ Social Media Automation
- ✅ VPS Hosting
- ✅ Payment Integration (Stripe)
- ✅ User Dashboard
- ✅ Admin Panel
- ✅ Analytics & Reporting
- ✅ 24/7 Customer Support

## Tech Stack

- **Frontend**: HTML5, CSS3, Vanilla JavaScript
- **Backend**: Node.js + Express.js
- **Database**: MongoDB (optional)
- **Payments**: Stripe
- **AI**: OpenAI API
- **Hosting**: Render, Railway, Heroku

## Installation

### Prerequisites
- Node.js 16+
- npm or yarn
- Stripe Account (for payments)
- OpenAI API Key (for AI features)

### Setup

```bash
# Clone the repository
git clone https://github.com/kred61601-crypto/RED-TECH-AI-2.git
cd website

# Install dependencies
npm install

# Create .env file
cp .env.example .env

# Add your API keys
# STRIPE_SECRET_KEY=your_key
# OPENAI_API_KEY=your_key

# Start server
npm start
```

## Deployment on Render

1. Push to GitHub
2. Go to Render.com
3. New → Web Service
4. Connect your GitHub repo (website folder)
5. Build command: `npm install`
6. Start command: `npm start`
7. Add environment variables
8. Deploy!

## Environment Variables

```env
PORT=3000
NODE_ENV=production
BASE_URL=https://your-render-url.onrender.com
MONGODB_URI=your_mongodb_uri
JWT_SECRET=your_jwt_secret
STRIPE_SECRET_KEY=sk_live_...
OPENAI_API_KEY=sk_...
STRIPE_WEBHOOK_SECRET=whsec_...
```

## API Routes

### Authentication
- `POST /api/auth/register` - Create account
- `POST /api/auth/login` - Login

### Services
- `GET /api/services` - Get all services
- `GET /api/services/:id` - Get service details

### Payments
- `POST /api/payments/create-checkout` - Create checkout session
- `POST /api/payments/webhook` - Stripe webhook

### AI
- `POST /api/ai/ask` - Ask AI questions

### Dashboard
- `GET /api/dashboard/stats` - Get dashboard stats
- `GET /api/dashboard/bots` - Get user bots

## File Structure

```
website/
├── public/
│   ├── index.html
│   ├── styles.css
│   └── app.js
├── routes/
│   ├── auth.js
│   ├── payments.js
│   ├── services.js
│   ├── dashboard.js
│   └── ai.js
├── .env.example
├── server.js
├── package.json
└── README.md
```

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

## License

ISC © 2026 REDTECH Studios

## Support

- 📧 Email: hello@redtech.io
- 💬 WhatsApp: +254 700 000 000
- 🌐 Website: https://redtech.io

---

**Made with ❤️ by REDTECH Studios**
