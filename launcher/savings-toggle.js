document.getElementById('toggle').addEventListener('click', () => window.savings.toggleVisibility());
window.savings.visibility(visible => {
  document.getElementById('label').textContent = visible ? 'Hide pill' : 'Show pill';
  const button = document.getElementById('toggle');
  button.setAttribute('aria-label', visible ? 'Hide savings pill' : 'Show savings pill');
  button.setAttribute('aria-pressed', String(visible));
});
