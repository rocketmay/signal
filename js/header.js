const headerTarget = document.getElementById('header-include');
const currentPage = (location.pathname.split('/').pop() || 'index.html');
const pageName = currentPage.replace(/\.html$/, '') || 'index';
const pageCategory = document.body.dataset.category;

document.body.classList.add(`page-${pageName}`);

function setHeaderPageState(page) {
  const navItem = document.querySelector(`.nav-item[data-page="${page}"]`);
  const iconCell = document.querySelector(`.icon-cell[data-page="${page}"]`);

  if (navItem) {
    navItem.classList.add('active');
  }

  if (iconCell) {
    iconCell.classList.add('active');
  }
}

function setHeaderCategoryState(category) {
  const iconCell = document.querySelector(`.icon-cell[data-category="${category}"]`);
  if (iconCell) {
    iconCell.classList.add('active');
  }
}

if (headerTarget) {
  const scriptUrl = document.currentScript.src;
  const rootUrl = new URL('../', scriptUrl).href;
  const headerUrl = new URL('../header.html', scriptUrl).href;

  function resolveHeaderRelativePaths(target) {
    target.querySelectorAll('[src]').forEach(el => {
      const src = el.getAttribute('src');
      if (!src || src.startsWith('#') || src.startsWith('/') || /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(src)) return;
      el.setAttribute('src', new URL(src, rootUrl).href);
    });

    target.querySelectorAll('[href]').forEach(el => {
      const href = el.getAttribute('href');
      if (!href || href.startsWith('#') || href.startsWith('/') || href.startsWith('mailto:') || href.startsWith('tel:') || /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(href)) return;
      el.setAttribute('href', new URL(href, rootUrl).href);
    });
  }

  fetch(headerUrl)
    .then(response => response.ok ? response.text() : Promise.reject(response.status))
    .then(html => {
      headerTarget.innerHTML = html;
      resolveHeaderRelativePaths(headerTarget);
      setHeaderPageState(currentPage);
      setHeaderCategoryState(pageCategory || pageName);
    })
    .catch(err => console.error('Failed to load header:', err));
}
