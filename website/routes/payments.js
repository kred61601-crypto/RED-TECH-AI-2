const express = require('express');
const router = express.Router();
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY || 'sk_test_fake');

const plans = {
  starter: { name: 'Starter', price: 900 },
  professional: { name: 'Professional', price: 2900 },
  enterprise: { name: 'Enterprise', price: 0 }
};

router.post('/create-checkout', async (req, res) => {
  try {
    const { plan, email } = req.body;

    if (!plans[plan]) {
      return res.status(400).json({ error: 'Invalid plan' });
    }

    if (plan === 'enterprise') {
      return res.json({
        success: true,
        message: 'Please contact sales for enterprise pricing'
      });
    }

    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items: [
        {
          price_data: {
            currency: 'usd',
            product_data: {
              name: `REDTECH ${plans[plan].name} Plan`,
              description: `Monthly subscription to REDTECH ${plans[plan].name} plan`
            },
            unit_amount: plans[plan].price,
            recurring: {
              interval: 'month'
            }
          },
          quantity: 1
        }
      ],
      mode: 'subscription',
      customer_email: email,
      success_url: `${process.env.BASE_URL || 'http://localhost:3000'}/dashboard?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${process.env.BASE_URL || 'http://localhost:3000'}/?cancelled=true`
    });

    res.json({
      success: true,
      url: session.url,
      sessionId: session.id
    });
  } catch (error) {
    console.error('Payment error:', error);
    res.status(500).json({ error: error.message });
  }
});

router.post('/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  const sig = req.headers['stripe-signature'];

  try {
    const event = await stripe.webhooks.constructEvent(
      req.body,
      sig,
      process.env.STRIPE_WEBHOOK_SECRET || 'whsec_test'
    );

    if (event.type === 'checkout.session.completed') {
      console.log('Payment successful:', event.data.object);
    }

    res.json({ received: true });
  } catch (error) {
    console.error('Webhook error:', error);
    res.status(400).send(`Webhook Error: ${error.message}`);
  }
});

module.exports = router;
