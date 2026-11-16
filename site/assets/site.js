// Follows a link to a heading that moved to another page, adds a copy button to each code block, and folds
// the Developers menu on narrow screens. The pages work without it.
(() => {
  const moved = document.querySelector('[data-moved]');
  const id = decodeURIComponent(location.hash.slice(1));
  if (!moved || !id || document.getElementById(id)) return;
  try {
    const to = JSON.parse(moved.getAttribute('data-moved'))[id];
    if (to) location.replace(`${to}#${encodeURIComponent(id)}`);
  } catch {
    // a malformed map: stay on this page
  }
})();

document.addEventListener('DOMContentLoaded', () => {
  const menu = document.querySelector('.side-menu');
  if (menu && window.matchMedia('(max-width: 999px)').matches) menu.open = false;
  if (!navigator.clipboard) return;
  for (const pre of document.querySelectorAll('pre')) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'copy';
    button.textContent = 'Copy';
    button.setAttribute('aria-label', 'Copy this code');
    button.addEventListener('click', async () => {
      const code = pre.querySelector('code');
      try {
        await navigator.clipboard.writeText((code ?? pre).innerText);
        button.textContent = 'Copied';
      } catch {
        button.textContent = 'Failed';
      }
      setTimeout(() => {
        button.textContent = 'Copy';
      }, 1500);
    });
    pre.classList.add('has-copy');
    pre.append(button);
  }
});
