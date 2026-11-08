/**
 * Landing page: sign in, create an account, or use the offline demo.
 */
import { signInLocal, getSession, LOGO_SVG, $, $$ } from './common.js';
import { signIn, signUp } from '../cloud.js';

const params = new URLSearchParams(location.search);
const note = $('#nextNote');
const home = (s) => (s.role === 'accountant' ? '/accountant.html' : '/app.html');
const go = (s) => {
  const next = params.get('next');
  // only follow "next" if it matches the role (a taxpayer can't be sent to the accountant page)
  location.href = next && next.includes(s.role === 'accountant' ? 'accountant' : 'app') ? next : home(s);
};

$('#brandSlot').innerHTML = `<a class="brand big" href="/">${LOGO_SVG}<span>TaxMate</span></a>`;

// ---- messages at the top of the card
const s = getSession();
if (params.get('msg')) note.textContent = params.get('msg');
else if (params.get('role')) note.textContent = `Please sign in as ${params.get('role') === 'accountant' ? 'an accountant' : 'a taxpayer'} to continue.`;
else if (s) {
  note.innerHTML = 'Signed in as <b></b>. <a>Continue</a>';
  note.querySelector('b').textContent = s.name;
  note.querySelector('a').href = home(s);
}

// ---- tabs
function showTab(name) {
  $$('.tabs button').forEach((b) => b.classList.toggle('on', b.dataset.tab === name));
  $$('[data-panel]').forEach((p) => { p.hidden = p.dataset.panel !== name; });
}
$$('.tabs button').forEach((b) => b.addEventListener('click', () => showTab(b.dataset.tab)));

// ---- show the practice code box only for accountants
$$('input[name=upRole]').forEach((r) => r.addEventListener('change', () => {
  const acct = $('input[name=upRole]:checked').value === 'accountant';
  $('#codeRow').hidden = !acct;
  $('#upCode').required = acct;
}));

function busy(form, on, label) {
  const btn = form.querySelector('button.primary');
  btn.disabled = on;
  btn.dataset.label ??= btn.textContent;
  btn.textContent = on ? label : btn.dataset.label;
}
function message(el, text, kind = 'err') {
  el.textContent = text;
  el.className = `form-msg ${kind}`;
}

// ---- sign in
$('#signinForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.currentTarget;
  busy(form, true, 'Signing in...');
  message($('#inMsg'), '');
  try {
    go(await signIn($('#inEmail').value.trim(), $('#inPassword').value));
  } catch (error) {
    message($('#inMsg'), error.message);
  } finally {
    busy(form, false);
  }
});

// ---- create account
$('#signupForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.currentTarget;
  busy(form, true, 'Creating account...');
  message($('#upMsg'), '');
  try {
    const result = await signUp({
      fullName: $('#upName').value.trim(),
      email: $('#upEmail').value.trim(),
      password: $('#upPassword').value,
      role: $('input[name=upRole]:checked').value,
      practiceCode: $('#upCode').value.trim()
    });
    if (result.needsConfirmation) {
      message($('#upMsg'), 'Account created. Check your email for the confirmation link, then sign in.', 'ok');
      showTab('signin');
      $('#inEmail').value = $('#upEmail').value;
      message($('#inMsg'), 'Confirm your email, then sign in here.', 'ok');
      return;
    }
    if (result.warning) sessionStorage.setItem('ll.flash', result.warning);
    go(result);
  } catch (error) {
    message($('#upMsg'), error.message);
  } finally {
    busy(form, false);
  }
});

// ---- offline demo
$$('[data-demo]').forEach((b) => b.addEventListener('click', () => {
  const [name, role] = b.dataset.demo.split('|');
  go(signInLocal(name, role));
}));

if (params.get('tab')) showTab(params.get('tab'));
