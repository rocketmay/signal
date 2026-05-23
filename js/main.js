// Minimal JS: set active nav item based on filename
(() => {
  const page = (location.pathname.split('/').pop() || 'index.html');
  document.querySelectorAll('.nav-item').forEach(el => {
    if (el.dataset.page === page) el.classList.add('active');
  });
})();
