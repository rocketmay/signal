const headerTarget = document.getElementById('header-include');
const currentPage = (location.pathname.split('/').pop() || 'index.html');
const pageName = currentPage.replace(/\.html$/, '') || 'index';

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

if (headerTarget) {
  fetch('header.html')
    .then(response => response.ok ? response.text() : Promise.reject(response.status))
    .then(html => {
      headerTarget.innerHTML = html;
      setHeaderPageState(currentPage);
    })
    .catch(err => console.error('Failed to load header:', err));
}
