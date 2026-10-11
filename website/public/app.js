// REDTECH Frontend App

const authModal = document.getElementById('authModal');
const modalContent = document.getElementById('modalContent');
const closeModal = document.getElementById('closeModal');

const navLogin = document.getElementById('navLogin');
const navSignup = document.getElementById('navSignup');

// Load Services
async function loadServices() {
  try {
    const response = await fetch('/api/services');
    const data = await response.json();
    const grid = document.getElementById('servicesGrid');
    
    grid.innerHTML = data.services.map(service => `
      <div class="service-card">
        <div class="icon">${getServiceIcon(service.name)}</div>
        <h3>${service.name}</h3>
        <p>${service.description}</p>
        <div class="price">${service.price}</div>
      </div>
    `).join('');
  } catch (error) {
    console.error('Failed to load services:', error);
  }
}

function getServiceIcon(name) {
  const icons = {
    'WhatsApp Bot Hosting': '💬',
    'Social Media Boosting': '📈',
    'VPS Hosting': '🖥️',
    'Premium Accounts': '⭐',
    'AI Integration': '🤖'
  };
  return icons[name] || '✨';
}

// Auth Modal
function openAuthModal(type) {
  if (type === 'login') {
    modalContent.innerHTML = `
      <h2>Login to REDTECH</h2>
      <form id="loginForm" style="margin-top: 20px;">
        <input type="email" placeholder="Email" required style="width: 100%; padding: 12px; margin-bottom: 12px; background: var(--bg-tertiary); border: 1px solid var(--border); border-radius: 8px; color: var(--text);">
        <input type="password" placeholder="Password" required style="width: 100%; padding: 12px; margin-bottom: 20px; background: var(--bg-tertiary); border: 1px solid var(--border); border-radius: 8px; color: var(--text);">
        <button type="submit" class="btn btn-primary full">Login</button>
      </form>
      <p style="text-align: center; margin-top: 16px; color: var(--text-muted);">Don't have an account? <a href="#" onclick="openAuthModal('signup'); return false;" style="color: var(--primary);">Sign up</a></p>
    `;
  } else {
    modalContent.innerHTML = `
      <h2>Join REDTECH Today</h2>
      <form id="signupForm" style="margin-top: 20px;">
        <input type="text" placeholder="Full Name" required style="width: 100%; padding: 12px; margin-bottom: 12px; background: var(--bg-tertiary); border: 1px solid var(--border); border-radius: 8px; color: var(--text);">
        <input type="email" placeholder="Email" required style="width: 100%; padding: 12px; margin-bottom: 12px; background: var(--bg-tertiary); border: 1px solid var(--border); border-radius: 8px; color: var(--text);">
        <input type="password" placeholder="Password" required style="width: 100%; padding: 12px; margin-bottom: 20px; background: var(--bg-tertiary); border: 1px solid var(--border); border-radius: 8px; color: var(--text);">
        <button type="submit" class="btn btn-primary full">Create Account</button>
      </form>
      <p style="text-align: center; margin-top: 16px; color: var(--text-muted);">Already have an account? <a href="#" onclick="openAuthModal('login'); return false;" style="color: var(--primary);">Login</a></p>
    `;
  }
  authModal.classList.add('open');
}

function closeAuthModal() {
  authModal.classList.remove('open');
}

// Event Listeners
navLogin.addEventListener('click', () => openAuthModal('login'));
navSignup.addEventListener('click', () => openAuthModal('signup'));
closeModal.addEventListener('click', closeAuthModal);

authModal.addEventListener('click', (e) => {
  if (e.target === authModal) closeAuthModal();
});

// Initialize
loadServices();
