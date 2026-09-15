import '../shared/style.css';
import './report.css';
import { marked } from 'marked';
import katex from 'katex';
import 'katex/dist/katex.min.css';
import markdown from './report.md';
import pavilion from '../image/assets/pavilion-original.png';
const state = await window.spellcast.ready;
document.querySelector('#report').innerHTML = marked.parse(markdown.replace('{{pavilion}}', pavilion));
katex.render('V = A \\times h \\times \\eta = 80 \\times 40 \\times 0.75 = 2400\\;\\mathrm{L}', document.querySelector('#formula'), { displayMode: true, output: 'htmlAndMathml', throwOnError: true });
const headings = [...document.querySelectorAll('#report h2')];
headings.forEach((heading, index) => { heading.id = 'section-' + (index + 1); heading.tabIndex = 0; heading.style.cursor = 'pointer'; const select = () => { window.spellcast.select({ ids: [heading.id], label: heading.textContent }); headings.forEach(h => h.classList.toggle('selected-section', h === heading)); }; heading.onclick = select; heading.onkeydown = e => { if (e.key === 'Enter') select(); }; });
document.querySelector('#section').onclick = () => { const heading = headings.filter(h => h.getBoundingClientRect().top < 160).at(-1) ?? headings[0]; heading.click(); };
if (state.selection?.ids?.[0]) document.getElementById(state.selection.ids[0])?.classList.add('selected-section');
const pdf = document.querySelector('a[download]');
pdf.onclick = async event => {
  event.preventDefault();
  try {
    // A sandboxed document has an opaque origin; use a Blob for its download link.
    const response = await fetch(pdf.href); if (!response.ok) throw new Error('PDF download failed: ' + response.status);
    const url = URL.createObjectURL(await response.blob()), link = document.createElement('a');
    link.href = url; link.download = 'rain-garden-report.pdf'; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  } catch (error) { window.spellcast.reportError(error); }
};
