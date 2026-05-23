const footerTarget = document.getElementById('footer-include');
if (footerTarget) {
  fetch('footer.html')
    .then(response => response.ok ? response.text() : Promise.reject(response.status))
    .then(html => { footerTarget.innerHTML = html; })
    .catch(() => {
      footerTarget.innerHTML = '<footer class="site-footer"><div class="footer-left">// Est. 2026 Vancouver, BC</div><div class="footer-right">Transmission active <span class="block-cursor">▮</span></div></footer>';
    });
}
