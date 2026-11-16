// Adds a copy button to each code block, and folds the docs menu on narrow screens. The pages work without it.
document.addEventListener('DOMContentLoaded', () => {
  const menu = document.querySelector('.docs-menu');
  if (menu && window.matchMedia('(max-width: 979px)').matches) menu.open = false;
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
