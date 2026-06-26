/* @ds-bundle: {"format":3,"namespace":"Spectrum2DesignSystem_b6d1b3","components":[{"name":"ActionButton","sourcePath":"components/buttons/ActionButton.jsx"},{"name":"Button","sourcePath":"components/buttons/Button.jsx"},{"name":"Avatar","sourcePath":"components/display/Avatar.jsx"},{"name":"Card","sourcePath":"components/display/Card.jsx"},{"name":"Tabs","sourcePath":"components/display/Tabs.jsx"},{"name":"Checkbox","sourcePath":"components/forms/Checkbox.jsx"},{"name":"RadioGroup","sourcePath":"components/forms/RadioGroup.jsx"},{"name":"Radio","sourcePath":"components/forms/RadioGroup.jsx"},{"name":"Switch","sourcePath":"components/forms/Switch.jsx"},{"name":"TextField","sourcePath":"components/forms/TextField.jsx"},{"name":"Badge","sourcePath":"components/status/Badge.jsx"},{"name":"InlineAlert","sourcePath":"components/status/InlineAlert.jsx"},{"name":"Meter","sourcePath":"components/status/Meter.jsx"},{"name":"StatusLight","sourcePath":"components/status/StatusLight.jsx"},{"name":"Tag","sourcePath":"components/status/Tag.jsx"}],"sourceHashes":{"components/buttons/ActionButton.jsx":"5177753c8373","components/buttons/Button.jsx":"e5065fecba91","components/display/Avatar.jsx":"04c2baaa9c60","components/display/Card.jsx":"2d65087d91a3","components/display/Tabs.jsx":"a686e1bde70b","components/forms/Checkbox.jsx":"48ef36311b37","components/forms/RadioGroup.jsx":"d7dce030a16d","components/forms/Switch.jsx":"1a7ba09b6c7d","components/forms/TextField.jsx":"62479fdf3af3","components/status/Badge.jsx":"9ee9f6c07d50","components/status/InlineAlert.jsx":"a99a69ea5017","components/status/Meter.jsx":"3945d151b77a","components/status/StatusLight.jsx":"8511df1ece4d","components/status/Tag.jsx":"a739723579c9","ui_kits/creative_cloud/App.jsx":"1a6934ce0929","ui_kits/creative_cloud/Shell.jsx":"40c6d3cfbc5c"},"inlinedExternals":[],"unexposedExports":[]} */

(() => {

const __ds_ns = (window.Spectrum2DesignSystem_b6d1b3 = window.Spectrum2DesignSystem_b6d1b3 || {});

const __ds_scope = {};

(__ds_ns.__errors = __ds_ns.__errors || []);

// components/buttons/ActionButton.jsx
try { (() => {
function _extends() { return _extends = Object.assign ? Object.assign.bind() : function (n) { for (var e = 1; e < arguments.length; e++) { var t = arguments[e]; for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]); } return n; }, _extends.apply(null, arguments); }
const CSS = `
.s2-action{
  -webkit-appearance:none;appearance:none;box-sizing:border-box;
  display:inline-flex;align-items:center;justify-content:center;gap:6px;
  font-family:var(--font-sans);font-weight:var(--font-weight-medium);
  color:var(--text-neutral);background:var(--spectrum-gray-100);
  border:1px solid var(--spectrum-gray-300);border-radius:var(--radius-default);
  cursor:pointer;user-select:none;white-space:nowrap;
  transition:background-color var(--duration-100) var(--ease-default),border-color var(--duration-100) var(--ease-default);
}
.s2-action:hover{background:var(--spectrum-gray-200);border-color:var(--spectrum-gray-400);}
.s2-action:active{background:var(--spectrum-gray-300);}
.s2-action:focus-visible{outline:2px solid var(--focus-ring);outline-offset:2px;}
.s2-action svg{width:1.15em;height:1.15em;flex:0 0 auto;}
.s2-action--S{height:24px;font-size:var(--font-size-ui-sm);padding:0 8px;}
.s2-action--M{height:32px;font-size:var(--font-size-ui);padding:0 12px;}
.s2-action--L{height:40px;font-size:var(--font-size-ui-lg);padding:0 16px;}
.s2-action--iconOnly.s2-action--S{width:24px;padding:0;}
.s2-action--iconOnly.s2-action--M{width:32px;padding:0;}
.s2-action--iconOnly.s2-action--L{width:40px;padding:0;}
/* quiet: no chrome until hover */
.s2-action--quiet{background:transparent;border-color:transparent;}
.s2-action--quiet:hover{background:var(--highlight-hover);border-color:transparent;}
.s2-action--quiet:active{background:var(--highlight-active);}
/* selected (toggle on) */
.s2-action--selected{background:var(--neutral-default);border-color:var(--neutral-default);color:var(--text-on-accent);}
.s2-action--selected:hover{background:var(--neutral-hover);border-color:var(--neutral-hover);}
.s2-action:disabled{background:var(--spectrum-gray-100);color:var(--text-disabled);border-color:transparent;cursor:default;pointer-events:none;}
`;
let injected = false;
function inject() {
  if (injected || typeof document === 'undefined') return;
  injected = true;
  const s = document.createElement('style');
  s.setAttribute('data-s2', 'action-button');
  s.textContent = CSS;
  document.head.appendChild(s);
}

/**
 * Spectrum 2 ActionButton — a rounded-rect button for toolbars and
 * inline actions. Supports icon-only, quiet, and selected (toggle) states.
 */
function ActionButton({
  size = 'M',
  isQuiet = false,
  isSelected = false,
  isDisabled = false,
  icon = null,
  children,
  onPress,
  'aria-label': ariaLabel,
  ...rest
}) {
  inject();
  const iconOnly = children == null;
  const cls = ['s2-action', `s2-action--${size}`, isQuiet && 's2-action--quiet', isSelected && 's2-action--selected', iconOnly && 's2-action--iconOnly'].filter(Boolean).join(' ');
  return /*#__PURE__*/React.createElement("button", _extends({
    type: "button",
    className: cls,
    disabled: isDisabled,
    onClick: onPress,
    "aria-label": ariaLabel,
    "aria-pressed": isSelected || undefined
  }, rest), icon, children != null && /*#__PURE__*/React.createElement("span", null, children));
}
Object.assign(__ds_scope, { ActionButton });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/buttons/ActionButton.jsx", error: String((e && e.message) || e) }); }

// components/buttons/Button.jsx
try { (() => {
function _extends() { return _extends = Object.assign ? Object.assign.bind() : function (n) { for (var e = 1; e < arguments.length; e++) { var t = arguments[e]; for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]); } return n; }, _extends.apply(null, arguments); }
const {
  useState
} = React;
/* Spectrum 2 Button — injected styles so the component is self-contained
   wherever it is mounted (cards, UI kits, consumer apps). */
const CSS = `
.s2-btn{
  -webkit-appearance:none;appearance:none;box-sizing:border-box;
  display:inline-flex;align-items:center;justify-content:center;gap:6px;
  font-family:var(--font-sans);font-weight:var(--font-weight-bold);
  border-radius:var(--radius-full);border:2px solid transparent;
  cursor:pointer;user-select:none;white-space:nowrap;text-decoration:none;
  transition:background-color var(--duration-100) var(--ease-default),
             border-color var(--duration-100) var(--ease-default),
             color var(--duration-100) var(--ease-default),
             transform var(--duration-100) var(--ease-default);
}
.s2-btn:active{transform:scale(.98);}
.s2-btn:focus-visible{outline:2px solid var(--focus-ring);outline-offset:2px;}
.s2-btn svg{width:1.15em;height:1.15em;flex:0 0 auto;}

/* sizes */
.s2-btn--S{height:24px;font-size:var(--font-size-ui-sm);padding:0 12px;}
.s2-btn--M{height:32px;font-size:var(--font-size-ui);padding:0 16px;}
.s2-btn--L{height:40px;font-size:var(--font-size-ui-lg);padding:0 20px;}
.s2-btn--XL{height:48px;font-size:var(--font-size-ui-xl);padding:0 26px;}

/* fill variants */
.s2-btn--fill.s2-btn--primary{background:var(--neutral-default);color:var(--text-on-accent);}
.s2-btn--fill.s2-btn--primary:hover{background:var(--neutral-hover);}
.s2-btn--fill.s2-btn--secondary{background:var(--spectrum-gray-100);color:var(--text-neutral);border-color:var(--spectrum-gray-300);}
.s2-btn--fill.s2-btn--secondary:hover{background:var(--spectrum-gray-200);border-color:var(--spectrum-gray-400);}
.s2-btn--fill.s2-btn--accent{background:var(--accent-default);color:#fff;}
.s2-btn--fill.s2-btn--accent:hover{background:var(--accent-hover);}
.s2-btn--fill.s2-btn--negative{background:var(--negative);color:#fff;}
.s2-btn--fill.s2-btn--negative:hover{background:var(--negative-hover);}

/* outline variants */
.s2-btn--outline{background:transparent;}
.s2-btn--outline.s2-btn--primary{color:var(--text-neutral);border-color:var(--spectrum-gray-800);}
.s2-btn--outline.s2-btn--secondary{color:var(--text-neutral);border-color:var(--spectrum-gray-300);}
.s2-btn--outline.s2-btn--accent{color:var(--accent-default);border-color:var(--accent-default);}
.s2-btn--outline.s2-btn--negative{color:var(--negative);border-color:var(--negative);}
.s2-btn--outline:hover{background:var(--spectrum-gray-100);}

/* disabled */
.s2-btn:disabled,.s2-btn[aria-disabled="true"]{
  background:var(--spectrum-gray-100);color:var(--text-disabled);
  border-color:transparent;cursor:default;pointer-events:none;transform:none;
}
.s2-btn--outline:disabled,.s2-btn--outline[aria-disabled="true"]{background:transparent;border-color:var(--spectrum-gray-200);}
`;
let injected = false;
function inject() {
  if (injected || typeof document === 'undefined') return;
  injected = true;
  const s = document.createElement('style');
  s.setAttribute('data-s2', 'button');
  s.textContent = CSS;
  document.head.appendChild(s);
}

/**
 * Spectrum 2 Button — pill-shaped action trigger.
 * Variants: primary (neutral), secondary, accent (blue), negative (red).
 */
function Button({
  variant = 'primary',
  size = 'M',
  fillStyle = 'fill',
  isDisabled = false,
  icon = null,
  children,
  onPress,
  type = 'button',
  ...rest
}) {
  inject();
  const cls = `s2-btn s2-btn--${size} s2-btn--${fillStyle} s2-btn--${variant}`;
  return /*#__PURE__*/React.createElement("button", _extends({
    type: type,
    className: cls,
    disabled: isDisabled,
    onClick: onPress
  }, rest), icon, children != null && /*#__PURE__*/React.createElement("span", null, children));
}
Object.assign(__ds_scope, { Button });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/buttons/Button.jsx", error: String((e && e.message) || e) }); }

// components/display/Avatar.jsx
try { (() => {
function _extends() { return _extends = Object.assign ? Object.assign.bind() : function (n) { for (var e = 1; e < arguments.length; e++) { var t = arguments[e]; for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]); } return n; }, _extends.apply(null, arguments); }
const CSS = `
.s2-avatar{display:inline-block;box-sizing:border-box;border-radius:var(--radius-full);overflow:hidden;background:var(--spectrum-gray-300);flex:0 0 auto;}
.s2-avatar img{width:100%;height:100%;object-fit:cover;display:block;}
.s2-avatar--initials{display:inline-flex;align-items:center;justify-content:center;color:#fff;font-family:var(--font-sans);font-weight:var(--font-weight-bold);background:var(--accent-default);}
`;
let injected = false;
function inject() {
  if (injected || typeof document === 'undefined') return;
  injected = true;
  const s = document.createElement('style');
  s.setAttribute('data-s2', 'avatar');
  s.textContent = CSS;
  document.head.appendChild(s);
}
const SIZES = {
  XS: 18,
  S: 24,
  M: 32,
  L: 40,
  XL: 56
};

/**
 * Spectrum 2 Avatar — a round representation of a person or entity.
 * Renders an image, or falls back to initials.
 */
function Avatar({
  src,
  alt = '',
  initials,
  size = 'M',
  ...rest
}) {
  inject();
  const px = typeof size === 'number' ? size : SIZES[size] || 32;
  const style = {
    width: px,
    height: px,
    fontSize: Math.round(px * 0.42)
  };
  if (src) {
    return /*#__PURE__*/React.createElement("span", _extends({
      className: "s2-avatar",
      style: style
    }, rest), /*#__PURE__*/React.createElement("img", {
      src: src,
      alt: alt
    }));
  }
  return /*#__PURE__*/React.createElement("span", _extends({
    className: "s2-avatar s2-avatar--initials",
    style: style,
    "aria-label": alt || initials
  }, rest), initials);
}
Object.assign(__ds_scope, { Avatar });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/display/Avatar.jsx", error: String((e && e.message) || e) }); }

// components/display/Card.jsx
try { (() => {
function _extends() { return _extends = Object.assign ? Object.assign.bind() : function (n) { for (var e = 1; e < arguments.length; e++) { var t = arguments[e]; for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]); } return n; }, _extends.apply(null, arguments); }
const CSS = `
.s2-card{
  display:flex;flex-direction:column;box-sizing:border-box;font-family:var(--font-sans);
  background:var(--surface-card);border:1px solid var(--spectrum-gray-200);
  border-radius:var(--radius-lg);overflow:hidden;width:240px;
  transition:box-shadow var(--duration-200) var(--ease-default),transform var(--duration-200) var(--ease-default),border-color var(--duration-200) var(--ease-default);
}
.s2-card--selectable{cursor:pointer;}
.s2-card--selectable:hover{box-shadow:var(--shadow-elevated);border-color:var(--spectrum-gray-300);transform:translateY(-2px);}
.s2-card--selected{border-color:var(--accent-default);box-shadow:0 0 0 1px var(--accent-default);}
.s2-card__media{aspect-ratio:3/2;background:var(--spectrum-gray-100);overflow:hidden;}
.s2-card__media img{width:100%;height:100%;object-fit:cover;display:block;}
.s2-card__body{display:flex;flex-direction:column;gap:4px;padding:14px 16px;}
.s2-card__title{font-size:var(--font-size-ui-lg);font-weight:var(--font-weight-bold);color:var(--text-heading);}
.s2-card__desc{font-size:var(--font-size-ui-sm);color:var(--text-neutral-subdued);line-height:var(--line-height-body);}
.s2-card__footer{display:flex;align-items:center;gap:8px;padding:0 16px 14px;}
`;
let injected = false;
function inject() {
  if (injected || typeof document === 'undefined') return;
  injected = true;
  const s = document.createElement('style');
  s.setAttribute('data-s2', 'card');
  s.textContent = CSS;
  document.head.appendChild(s);
}

/**
 * Spectrum 2 Card — a surface grouping media, a title, description,
 * and optional footer actions. Use for galleries and asset grids.
 */
function Card({
  image,
  imageAlt = '',
  title,
  description,
  footer,
  isSelectable = false,
  isSelected = false,
  onPress,
  children,
  ...rest
}) {
  inject();
  const cls = ['s2-card', isSelectable && 's2-card--selectable', isSelected && 's2-card--selected'].filter(Boolean).join(' ');
  return /*#__PURE__*/React.createElement("div", _extends({
    className: cls,
    onClick: isSelectable ? onPress : undefined
  }, rest), image && /*#__PURE__*/React.createElement("div", {
    className: "s2-card__media"
  }, /*#__PURE__*/React.createElement("img", {
    src: image,
    alt: imageAlt
  })), (title || description) && /*#__PURE__*/React.createElement("div", {
    className: "s2-card__body"
  }, title && /*#__PURE__*/React.createElement("div", {
    className: "s2-card__title"
  }, title), description && /*#__PURE__*/React.createElement("div", {
    className: "s2-card__desc"
  }, description)), children, footer && /*#__PURE__*/React.createElement("div", {
    className: "s2-card__footer"
  }, footer));
}
Object.assign(__ds_scope, { Card });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/display/Card.jsx", error: String((e && e.message) || e) }); }

// components/display/Tabs.jsx
try { (() => {
const {
  useState
} = React;
const CSS = `
.s2-tabs{font-family:var(--font-sans);}
.s2-tabs__list{display:flex;gap:24px;border-bottom:1px solid var(--spectrum-gray-300);position:relative;}
.s2-tabs--compact .s2-tabs__list{gap:16px;}
.s2-tab{
  -webkit-appearance:none;appearance:none;background:none;border:0;padding:10px 0 12px;cursor:pointer;
  font-family:var(--font-sans);font-size:var(--font-size-ui);font-weight:var(--font-weight-regular);
  color:var(--text-neutral-subdued);position:relative;display:inline-flex;align-items:center;gap:7px;
  transition:color var(--duration-100) var(--ease-default);white-space:nowrap;
}
.s2-tab svg{width:18px;height:18px;}
.s2-tab:hover{color:var(--text-body);}
.s2-tab--selected{color:var(--text-heading);font-weight:var(--font-weight-bold);}
.s2-tab--selected::after{
  content:"";position:absolute;left:0;right:0;bottom:-1px;height:2px;border-radius:2px;
  background:var(--neutral-default);
}
.s2-tabs--emphasized .s2-tab--selected::after{background:var(--accent-default);}
.s2-tab:focus-visible{outline:2px solid var(--focus-ring);outline-offset:2px;border-radius:var(--radius-sm);}
.s2-tab:disabled{color:var(--text-disabled);cursor:default;}
.s2-tabs__panel{padding-top:16px;font-size:var(--font-size-ui);color:var(--text-body);line-height:var(--line-height-body);}
`;
let injected = false;
function inject() {
  if (injected || typeof document === 'undefined') return;
  injected = true;
  const s = document.createElement('style');
  s.setAttribute('data-s2', 'tabs');
  s.textContent = CSS;
  document.head.appendChild(s);
}

/**
 * Spectrum 2 Tabs — a horizontal tab list with an active indicator.
 * `items` is an array of {id, label, icon?, content?, isDisabled?}.
 */
function Tabs({
  items = [],
  selectedKey,
  defaultSelectedKey,
  isEmphasized = false,
  isCompact = false,
  onChange,
  children
}) {
  inject();
  const [internal, setInternal] = useState(defaultSelectedKey ?? (items[0] && items[0].id));
  const selected = selectedKey !== undefined ? selectedKey : internal;
  const select = id => {
    if (selectedKey === undefined) setInternal(id);
    onChange && onChange(id);
  };
  const active = items.find(i => i.id === selected);
  const cls = ['s2-tabs', isEmphasized && 's2-tabs--emphasized', isCompact && 's2-tabs--compact'].filter(Boolean).join(' ');
  return /*#__PURE__*/React.createElement("div", {
    className: cls
  }, /*#__PURE__*/React.createElement("div", {
    className: "s2-tabs__list",
    role: "tablist"
  }, items.map(item => /*#__PURE__*/React.createElement("button", {
    key: item.id,
    type: "button",
    role: "tab",
    "aria-selected": item.id === selected,
    disabled: item.isDisabled,
    className: `s2-tab${item.id === selected ? ' s2-tab--selected' : ''}`,
    onClick: () => select(item.id)
  }, item.icon, item.label))), active && active.content != null && /*#__PURE__*/React.createElement("div", {
    className: "s2-tabs__panel",
    role: "tabpanel"
  }, active.content), children);
}
Object.assign(__ds_scope, { Tabs });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/display/Tabs.jsx", error: String((e && e.message) || e) }); }

// components/forms/Checkbox.jsx
try { (() => {
function _extends() { return _extends = Object.assign ? Object.assign.bind() : function (n) { for (var e = 1; e < arguments.length; e++) { var t = arguments[e]; for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]); } return n; }, _extends.apply(null, arguments); }
const {
  useState
} = React;
const CSS = `
.s2-cb{display:inline-flex;align-items:flex-start;gap:8px;font-family:var(--font-sans);font-size:var(--font-size-ui);color:var(--text-body);cursor:pointer;user-select:none;line-height:var(--line-height-ui);}
.s2-cb input{position:absolute;opacity:0;width:0;height:0;}
.s2-cb__box{
  box-sizing:border-box;flex:0 0 auto;width:16px;height:16px;margin-top:2px;
  border:2px solid var(--spectrum-gray-700);border-radius:var(--radius-sm);
  background:var(--background-layer-1);
  display:flex;align-items:center;justify-content:center;
  transition:background-color var(--duration-100) var(--ease-default),border-color var(--duration-100) var(--ease-default);
}
.s2-cb__box svg{width:11px;height:11px;color:#fff;opacity:0;transform:scale(.6);transition:opacity var(--duration-100),transform var(--duration-100);}
.s2-cb:hover .s2-cb__box{border-color:var(--spectrum-gray-800);}
.s2-cb--checked .s2-cb__box,.s2-cb--indeterminate .s2-cb__box{background:var(--neutral-default);border-color:var(--neutral-default);}
.s2-cb--emphasized.s2-cb--checked .s2-cb__box,.s2-cb--emphasized.s2-cb--indeterminate .s2-cb__box{background:var(--accent-default);border-color:var(--accent-default);}
.s2-cb--checked .s2-cb__box svg,.s2-cb--indeterminate .s2-cb__box svg{opacity:1;transform:scale(1);}
.s2-cb input:focus-visible + .s2-cb__box{outline:2px solid var(--focus-ring);outline-offset:2px;}
.s2-cb--disabled{color:var(--text-disabled);cursor:default;}
.s2-cb--disabled .s2-cb__box{border-color:var(--spectrum-gray-300);background:var(--spectrum-gray-100);}
`;
let injected = false;
function inject() {
  if (injected || typeof document === 'undefined') return;
  injected = true;
  const s = document.createElement('style');
  s.setAttribute('data-s2', 'checkbox');
  s.textContent = CSS;
  document.head.appendChild(s);
}
const Check = /*#__PURE__*/React.createElement("svg", {
  viewBox: "0 0 12 12",
  fill: "none"
}, /*#__PURE__*/React.createElement("path", {
  d: "M10 3 4.6 8.6 2 6",
  stroke: "currentColor",
  strokeWidth: "2",
  strokeLinecap: "round",
  strokeLinejoin: "round"
}));
const Dash = /*#__PURE__*/React.createElement("svg", {
  viewBox: "0 0 12 12",
  fill: "none"
}, /*#__PURE__*/React.createElement("path", {
  d: "M2.5 6h7",
  stroke: "currentColor",
  strokeWidth: "2",
  strokeLinecap: "round"
}));

/**
 * Spectrum 2 Checkbox — a single boolean control with optional
 * indeterminate state and an emphasized (accent) treatment.
 */
function Checkbox({
  children,
  isSelected,
  defaultSelected = false,
  isIndeterminate = false,
  isEmphasized = false,
  isDisabled = false,
  onChange,
  ...rest
}) {
  inject();
  const [internal, setInternal] = useState(defaultSelected);
  const checked = isSelected !== undefined ? isSelected : internal;
  const cls = ['s2-cb', isEmphasized && 's2-cb--emphasized', checked && 's2-cb--checked', isIndeterminate && 's2-cb--indeterminate', isDisabled && 's2-cb--disabled'].filter(Boolean).join(' ');
  return /*#__PURE__*/React.createElement("label", {
    className: cls
  }, /*#__PURE__*/React.createElement("input", _extends({
    type: "checkbox",
    checked: checked,
    disabled: isDisabled,
    onChange: e => {
      if (isSelected === undefined) setInternal(e.target.checked);
      onChange && onChange(e.target.checked);
    }
  }, rest)), /*#__PURE__*/React.createElement("span", {
    className: "s2-cb__box"
  }, isIndeterminate ? Dash : Check), children != null && /*#__PURE__*/React.createElement("span", null, children));
}
Object.assign(__ds_scope, { Checkbox });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/forms/Checkbox.jsx", error: String((e && e.message) || e) }); }

// components/forms/RadioGroup.jsx
try { (() => {
const {
  useState,
  createContext,
  useContext
} = React;
const CSS = `
.s2-radiogroup{display:flex;flex-direction:column;gap:10px;font-family:var(--font-sans);}
.s2-radiogroup__label{font-size:var(--font-size-ui);color:var(--text-neutral-subdued);}
.s2-radiogroup--horizontal .s2-radiogroup__items{flex-direction:row;gap:16px;}
.s2-radiogroup__items{display:flex;flex-direction:column;gap:10px;}
.s2-radio{display:inline-flex;align-items:center;gap:8px;font-size:var(--font-size-ui);color:var(--text-body);cursor:pointer;user-select:none;}
.s2-radio input{position:absolute;opacity:0;width:0;height:0;}
.s2-radio__dot{
  box-sizing:border-box;flex:0 0 auto;width:16px;height:16px;border-radius:var(--radius-full);
  border:2px solid var(--spectrum-gray-700);background:var(--background-layer-1);
  display:flex;align-items:center;justify-content:center;
  transition:border-color var(--duration-100) var(--ease-default),border-width var(--duration-100) var(--ease-default);
}
.s2-radio:hover .s2-radio__dot{border-color:var(--spectrum-gray-800);}
.s2-radio--checked .s2-radio__dot{border-color:var(--neutral-default);border-width:5px;}
.s2-radio--checked.s2-radio--emphasized .s2-radio__dot{border-color:var(--accent-default);}
.s2-radio input:focus-visible + .s2-radio__dot{outline:2px solid var(--focus-ring);outline-offset:2px;}
.s2-radio--disabled{color:var(--text-disabled);cursor:default;}
.s2-radio--disabled .s2-radio__dot{border-color:var(--spectrum-gray-300);}
`;
let injected = false;
function inject() {
  if (injected || typeof document === 'undefined') return;
  injected = true;
  const s = document.createElement('style');
  s.setAttribute('data-s2', 'radio');
  s.textContent = CSS;
  document.head.appendChild(s);
}
const RadioCtx = createContext(null);

/**
 * Spectrum 2 RadioGroup — wraps Radio children for single-select.
 */
function RadioGroup({
  label,
  value,
  defaultValue,
  orientation = 'vertical',
  isEmphasized = false,
  isDisabled = false,
  onChange,
  children
}) {
  inject();
  const [internal, setInternal] = useState(defaultValue ?? null);
  const selected = value !== undefined ? value : internal;
  const ctx = {
    selected,
    isEmphasized,
    groupDisabled: isDisabled,
    select: v => {
      if (value === undefined) setInternal(v);
      onChange && onChange(v);
    }
  };
  return /*#__PURE__*/React.createElement("div", {
    className: `s2-radiogroup s2-radiogroup--${orientation}`,
    role: "radiogroup",
    "aria-label": typeof label === 'string' ? label : undefined
  }, label && /*#__PURE__*/React.createElement("span", {
    className: "s2-radiogroup__label"
  }, label), /*#__PURE__*/React.createElement(RadioCtx.Provider, {
    value: ctx
  }, /*#__PURE__*/React.createElement("div", {
    className: "s2-radiogroup__items"
  }, children)));
}

/**
 * Spectrum 2 Radio — a single option inside a RadioGroup.
 */
function Radio({
  value,
  children,
  isDisabled = false
}) {
  inject();
  const ctx = useContext(RadioCtx);
  const checked = ctx ? ctx.selected === value : false;
  const disabled = isDisabled || ctx && ctx.groupDisabled;
  const cls = ['s2-radio', checked && 's2-radio--checked', ctx && ctx.isEmphasized && 's2-radio--emphasized', disabled && 's2-radio--disabled'].filter(Boolean).join(' ');
  return /*#__PURE__*/React.createElement("label", {
    className: cls
  }, /*#__PURE__*/React.createElement("input", {
    type: "radio",
    checked: checked,
    disabled: disabled,
    onChange: () => ctx && ctx.select(value)
  }), /*#__PURE__*/React.createElement("span", {
    className: "s2-radio__dot"
  }), children != null && /*#__PURE__*/React.createElement("span", null, children));
}
Object.assign(__ds_scope, { RadioGroup, Radio });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/forms/RadioGroup.jsx", error: String((e && e.message) || e) }); }

// components/forms/Switch.jsx
try { (() => {
function _extends() { return _extends = Object.assign ? Object.assign.bind() : function (n) { for (var e = 1; e < arguments.length; e++) { var t = arguments[e]; for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]); } return n; }, _extends.apply(null, arguments); }
const {
  useState
} = React;
const CSS = `
.s2-switch{display:inline-flex;align-items:center;gap:8px;font-family:var(--font-sans);font-size:var(--font-size-ui);color:var(--text-body);cursor:pointer;user-select:none;}
.s2-switch input{position:absolute;opacity:0;width:0;height:0;}
.s2-switch__track{
  box-sizing:border-box;position:relative;flex:0 0 auto;width:32px;height:18px;border-radius:var(--radius-full);
  background:var(--spectrum-gray-500);transition:background-color var(--duration-100) var(--ease-default);
}
.s2-switch__thumb{
  position:absolute;top:2px;left:2px;width:14px;height:14px;border-radius:var(--radius-full);
  background:#fff;box-shadow:0 1px 2px rgba(0,0,0,.25);
  transition:transform var(--duration-100) var(--ease-default);
}
.s2-switch:hover .s2-switch__track{background:var(--spectrum-gray-600);}
.s2-switch--on .s2-switch__track{background:var(--neutral-default);}
.s2-switch--on.s2-switch--emphasized .s2-switch__track{background:var(--accent-default);}
.s2-switch--on:hover .s2-switch__track{background:var(--neutral-hover);}
.s2-switch--on .s2-switch__thumb{transform:translateX(14px);}
.s2-switch input:focus-visible + .s2-switch__track{outline:2px solid var(--focus-ring);outline-offset:2px;}
.s2-switch--disabled{color:var(--text-disabled);cursor:default;}
.s2-switch--disabled .s2-switch__track{background:var(--spectrum-gray-300);}
`;
let injected = false;
function inject() {
  if (injected || typeof document === 'undefined') return;
  injected = true;
  const s = document.createElement('style');
  s.setAttribute('data-s2', 'switch');
  s.textContent = CSS;
  document.head.appendChild(s);
}

/**
 * Spectrum 2 Switch — a toggle for an instant on/off setting.
 * Use over Checkbox when the change applies immediately.
 */
function Switch({
  children,
  isSelected,
  defaultSelected = false,
  isEmphasized = false,
  isDisabled = false,
  onChange,
  ...rest
}) {
  inject();
  const [internal, setInternal] = useState(defaultSelected);
  const on = isSelected !== undefined ? isSelected : internal;
  const cls = ['s2-switch', on && 's2-switch--on', isEmphasized && 's2-switch--emphasized', isDisabled && 's2-switch--disabled'].filter(Boolean).join(' ');
  return /*#__PURE__*/React.createElement("label", {
    className: cls
  }, /*#__PURE__*/React.createElement("input", _extends({
    type: "checkbox",
    role: "switch",
    checked: on,
    disabled: isDisabled,
    onChange: e => {
      if (isSelected === undefined) setInternal(e.target.checked);
      onChange && onChange(e.target.checked);
    }
  }, rest)), /*#__PURE__*/React.createElement("span", {
    className: "s2-switch__track"
  }, /*#__PURE__*/React.createElement("span", {
    className: "s2-switch__thumb"
  })), children != null && /*#__PURE__*/React.createElement("span", null, children));
}
Object.assign(__ds_scope, { Switch });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/forms/Switch.jsx", error: String((e && e.message) || e) }); }

// components/forms/TextField.jsx
try { (() => {
function _extends() { return _extends = Object.assign ? Object.assign.bind() : function (n) { for (var e = 1; e < arguments.length; e++) { var t = arguments[e]; for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]); } return n; }, _extends.apply(null, arguments); }
const {
  useState
} = React;
const CSS = `
.s2-field{display:flex;flex-direction:column;gap:6px;font-family:var(--font-sans);}
.s2-field__label{font-size:var(--font-size-ui);color:var(--text-neutral-subdued);font-weight:var(--font-weight-regular);}
.s2-field__label .s2-req{color:var(--negative-visual);margin-inline-start:2px;}
.s2-field__input{
  box-sizing:border-box;height:32px;padding:0 12px;width:100%;
  font-family:var(--font-sans);font-size:var(--font-size-ui);color:var(--text-body);
  background:var(--background-layer-1);
  border:2px solid var(--spectrum-gray-300);border-radius:var(--radius-default);
  transition:border-color var(--duration-100) var(--ease-default);outline:none;
}
.s2-field__input::placeholder{color:var(--spectrum-gray-500);}
.s2-field__input:hover{border-color:var(--spectrum-gray-400);}
.s2-field__input:focus{border-color:var(--accent-default);}
.s2-field--invalid .s2-field__input{border-color:var(--negative);}
.s2-field--invalid .s2-field__input:focus{border-color:var(--negative);}
.s2-field__input:disabled{background:var(--spectrum-gray-100);border-color:var(--spectrum-gray-200);color:var(--text-disabled);cursor:default;}
.s2-field--L .s2-field__input{height:40px;font-size:var(--font-size-ui-lg);}
.s2-field--S .s2-field__input{height:24px;font-size:var(--font-size-ui-sm);}
.s2-field__help{font-size:var(--font-size-ui-sm);color:var(--text-neutral-subdued);}
.s2-field--invalid .s2-field__help{color:var(--negative-visual);}
`;
let injected = false;
function inject() {
  if (injected || typeof document === 'undefined') return;
  injected = true;
  const s = document.createElement('style');
  s.setAttribute('data-s2', 'textfield');
  s.textContent = CSS;
  document.head.appendChild(s);
}

/**
 * Spectrum 2 TextField — a labelled single-line text input with
 * optional description, validation, and sizes.
 */
function TextField({
  label,
  value,
  defaultValue,
  placeholder,
  type = 'text',
  size = 'M',
  isRequired = false,
  isInvalid = false,
  isDisabled = false,
  description,
  errorMessage,
  onChange,
  ...rest
}) {
  inject();
  const [internal, setInternal] = useState(defaultValue ?? '');
  const val = value !== undefined ? value : internal;
  const cls = `s2-field s2-field--${size}${isInvalid ? ' s2-field--invalid' : ''}`;
  const help = isInvalid ? errorMessage || description : description;
  return /*#__PURE__*/React.createElement("label", {
    className: cls
  }, label && /*#__PURE__*/React.createElement("span", {
    className: "s2-field__label"
  }, label, isRequired && /*#__PURE__*/React.createElement("span", {
    className: "s2-req"
  }, "*")), /*#__PURE__*/React.createElement("input", _extends({
    className: "s2-field__input",
    type: type,
    value: val,
    placeholder: placeholder,
    disabled: isDisabled,
    "aria-invalid": isInvalid || undefined,
    onChange: e => {
      if (value === undefined) setInternal(e.target.value);
      onChange && onChange(e.target.value, e);
    }
  }, rest)), help && /*#__PURE__*/React.createElement("span", {
    className: "s2-field__help"
  }, help));
}
Object.assign(__ds_scope, { TextField });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/forms/TextField.jsx", error: String((e && e.message) || e) }); }

// components/status/Badge.jsx
try { (() => {
function _extends() { return _extends = Object.assign ? Object.assign.bind() : function (n) { for (var e = 1; e < arguments.length; e++) { var t = arguments[e]; for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]); } return n; }, _extends.apply(null, arguments); }
const CSS = `
.s2-badge{
  display:inline-flex;align-items:center;gap:5px;box-sizing:border-box;
  font-family:var(--font-sans);font-weight:var(--font-weight-bold);font-size:var(--font-size-ui-sm);
  line-height:1;color:#fff;border-radius:var(--radius-sm);padding:4px 8px;white-space:nowrap;
}
.s2-badge svg{width:12px;height:12px;}
.s2-badge--S{font-size:var(--font-size-ui-xs);padding:3px 6px;}
.s2-badge--L{font-size:var(--font-size-ui);padding:5px 10px;}
.s2-badge--accent{background:var(--accent-default);}
.s2-badge--neutral{background:var(--spectrum-gray-700);}
.s2-badge--informative{background:var(--spectrum-blue-900);}
.s2-badge--positive{background:var(--spectrum-green-900);}
.s2-badge--negative{background:var(--spectrum-red-900);}
.s2-badge--notice{background:var(--spectrum-orange-900);}
.s2-badge--purple{background:var(--spectrum-purple-900);}
.s2-badge--seafoam{background:var(--spectrum-seafoam-900);}
.s2-badge--indigo{background:var(--spectrum-indigo-900);}
.s2-badge--magenta{background:var(--spectrum-magenta-900);}
`;
let injected = false;
function inject() {
  if (injected || typeof document === 'undefined') return;
  injected = true;
  const s = document.createElement('style');
  s.setAttribute('data-s2', 'badge');
  s.textContent = CSS;
  document.head.appendChild(s);
}

/**
 * Spectrum 2 Badge — a small, bold, color-coded label for statuses,
 * counts, or categories. Non-interactive.
 */
function Badge({
  variant = 'neutral',
  size = 'M',
  icon = null,
  children,
  ...rest
}) {
  inject();
  return /*#__PURE__*/React.createElement("span", _extends({
    className: `s2-badge s2-badge--${variant} s2-badge--${size}`
  }, rest), icon, children);
}
Object.assign(__ds_scope, { Badge });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/status/Badge.jsx", error: String((e && e.message) || e) }); }

// components/status/InlineAlert.jsx
try { (() => {
function _extends() { return _extends = Object.assign ? Object.assign.bind() : function (n) { for (var e = 1; e < arguments.length; e++) { var t = arguments[e]; for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]); } return n; }, _extends.apply(null, arguments); }
const CSS = `
.s2-alert{
  display:flex;gap:12px;box-sizing:border-box;font-family:var(--font-sans);
  border:2px solid var(--spectrum-gray-300);border-radius:var(--radius-default);
  background:var(--background-layer-1);padding:16px;max-width:560px;
}
.s2-alert__icon{flex:0 0 auto;width:20px;height:20px;margin-top:1px;color:var(--text-neutral);}
.s2-alert__icon svg{width:20px;height:20px;display:block;}
.s2-alert__body{display:flex;flex-direction:column;gap:4px;}
.s2-alert__title{font-size:var(--font-size-ui);font-weight:var(--font-weight-bold);color:var(--text-heading);}
.s2-alert__content{font-size:var(--font-size-ui);color:var(--text-body);line-height:var(--line-height-body);}
.s2-alert--informative{border-color:var(--informative-visual);}
.s2-alert--informative .s2-alert__icon{color:var(--informative-visual);}
.s2-alert--positive{border-color:var(--positive-visual);}
.s2-alert--positive .s2-alert__icon{color:var(--positive-visual);}
.s2-alert--notice{border-color:var(--notice-visual);}
.s2-alert--notice .s2-alert__icon{color:var(--notice-visual);}
.s2-alert--negative{border-color:var(--negative-visual);}
.s2-alert--negative .s2-alert__icon{color:var(--negative-visual);}
`;
let injected = false;
function inject() {
  if (injected || typeof document === 'undefined') return;
  injected = true;
  const s = document.createElement('style');
  s.setAttribute('data-s2', 'inlinealert');
  s.textContent = CSS;
  document.head.appendChild(s);
}
const ICONS = {
  informative: /*#__PURE__*/React.createElement("svg", {
    viewBox: "0 0 20 20",
    fill: "currentColor"
  }, /*#__PURE__*/React.createElement("path", {
    d: "M10 2a8 8 0 1 0 0 16 8 8 0 0 0 0-16Zm0 4a1 1 0 1 1 0 2 1 1 0 0 1 0-2Zm1.25 9h-2.5a.75.75 0 0 1 0-1.5h.5v-3h-.5a.75.75 0 0 1 0-1.5H10a.75.75 0 0 1 .75.75v3.75h.5a.75.75 0 0 1 0 1.5Z"
  })),
  positive: /*#__PURE__*/React.createElement("svg", {
    viewBox: "0 0 20 20",
    fill: "currentColor"
  }, /*#__PURE__*/React.createElement("path", {
    d: "M10 2a8 8 0 1 0 0 16 8 8 0 0 0 0-16Zm4.2 5.9-4.9 5.2a.85.85 0 0 1-1.2.03L5.8 10.9a.85.85 0 1 1 1.2-1.2l1.66 1.6 4.3-4.6a.85.85 0 1 1 1.24 1.16Z"
  })),
  notice: /*#__PURE__*/React.createElement("svg", {
    viewBox: "0 0 20 20",
    fill: "currentColor"
  }, /*#__PURE__*/React.createElement("path", {
    d: "M18.6 15.5 11.2 2.9a1.4 1.4 0 0 0-2.4 0L1.4 15.5A1.4 1.4 0 0 0 2.6 17.6h14.8a1.4 1.4 0 0 0 1.2-2.1ZM9 7.2a1 1 0 0 1 2 0v4a1 1 0 0 1-2 0Zm1 8.1a1.15 1.15 0 1 1 0-2.3 1.15 1.15 0 0 1 0 2.3Z"
  })),
  negative: /*#__PURE__*/React.createElement("svg", {
    viewBox: "0 0 20 20",
    fill: "currentColor"
  }, /*#__PURE__*/React.createElement("path", {
    d: "M10 2a8 8 0 1 0 0 16 8 8 0 0 0 0-16Zm-1 3.5a1 1 0 0 1 2 0v5a1 1 0 0 1-2 0Zm1 9.6a1.2 1.2 0 1 1 0-2.4 1.2 1.2 0 0 1 0 2.4Z"
  }))
};

/**
 * Spectrum 2 InlineAlert — a contained, in-context message with a
 * semantic border + icon. Use for form-level or section-level feedback.
 */
function InlineAlert({
  variant = 'informative',
  title,
  children,
  ...rest
}) {
  inject();
  return /*#__PURE__*/React.createElement("div", _extends({
    className: `s2-alert s2-alert--${variant}`,
    role: "alert"
  }, rest), /*#__PURE__*/React.createElement("span", {
    className: "s2-alert__icon"
  }, ICONS[variant]), /*#__PURE__*/React.createElement("div", {
    className: "s2-alert__body"
  }, title && /*#__PURE__*/React.createElement("div", {
    className: "s2-alert__title"
  }, title), children && /*#__PURE__*/React.createElement("div", {
    className: "s2-alert__content"
  }, children)));
}
Object.assign(__ds_scope, { InlineAlert });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/status/InlineAlert.jsx", error: String((e && e.message) || e) }); }

// components/status/Meter.jsx
try { (() => {
function _extends() { return _extends = Object.assign ? Object.assign.bind() : function (n) { for (var e = 1; e < arguments.length; e++) { var t = arguments[e]; for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]); } return n; }, _extends.apply(null, arguments); }
const CSS = `
.s2-meter{display:flex;flex-direction:column;gap:6px;font-family:var(--font-sans);min-width:160px;}
.s2-meter__top{display:flex;justify-content:space-between;align-items:baseline;gap:12px;}
.s2-meter__label{font-size:var(--font-size-ui);color:var(--text-neutral-subdued);}
.s2-meter__value{font-size:var(--font-size-ui-sm);color:var(--text-neutral-subdued);font-variant-numeric:tabular-nums;}
.s2-meter__track{height:6px;border-radius:var(--radius-full);background:var(--spectrum-gray-300);overflow:hidden;}
.s2-meter__fill{height:100%;border-radius:var(--radius-full);background:var(--neutral-default);transition:width var(--duration-300) var(--ease-default);}
.s2-meter--informative .s2-meter__fill{background:var(--informative-visual);}
.s2-meter--positive .s2-meter__fill{background:var(--positive-visual);}
.s2-meter--notice .s2-meter__fill{background:var(--notice-visual);}
.s2-meter--negative .s2-meter__fill{background:var(--negative-visual);}
`;
let injected = false;
function inject() {
  if (injected || typeof document === 'undefined') return;
  injected = true;
  const s = document.createElement('style');
  s.setAttribute('data-s2', 'meter');
  s.textContent = CSS;
  document.head.appendChild(s);
}

/**
 * Spectrum 2 Meter — a labelled bar showing a value within a known
 * range (storage used, score, capacity). Use a semantic variant to
 * signal health.
 */
function Meter({
  label,
  value = 0,
  minValue = 0,
  maxValue = 100,
  variant = 'informative',
  showValue = true,
  valueLabel,
  ...rest
}) {
  inject();
  const pct = Math.max(0, Math.min(100, (value - minValue) / (maxValue - minValue) * 100));
  return /*#__PURE__*/React.createElement("div", _extends({
    className: `s2-meter s2-meter--${variant}`,
    role: "meter",
    "aria-valuenow": value,
    "aria-valuemin": minValue,
    "aria-valuemax": maxValue
  }, rest), /*#__PURE__*/React.createElement("div", {
    className: "s2-meter__top"
  }, label && /*#__PURE__*/React.createElement("span", {
    className: "s2-meter__label"
  }, label), showValue && /*#__PURE__*/React.createElement("span", {
    className: "s2-meter__value"
  }, valueLabel ?? Math.round(pct) + '%')), /*#__PURE__*/React.createElement("div", {
    className: "s2-meter__track"
  }, /*#__PURE__*/React.createElement("div", {
    className: "s2-meter__fill",
    style: {
      width: pct + '%'
    }
  })));
}
Object.assign(__ds_scope, { Meter });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/status/Meter.jsx", error: String((e && e.message) || e) }); }

// components/status/StatusLight.jsx
try { (() => {
function _extends() { return _extends = Object.assign ? Object.assign.bind() : function (n) { for (var e = 1; e < arguments.length; e++) { var t = arguments[e]; for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]); } return n; }, _extends.apply(null, arguments); }
const CSS = `
.s2-status{display:inline-flex;align-items:center;gap:8px;font-family:var(--font-sans);font-size:var(--font-size-ui);color:var(--text-body);line-height:var(--line-height-ui);}
.s2-status__dot{flex:0 0 auto;width:9px;height:9px;border-radius:var(--radius-full);background:var(--spectrum-gray-500);}
.s2-status--neutral .s2-status__dot{background:var(--spectrum-gray-500);}
.s2-status--informative .s2-status__dot{background:var(--informative-visual);}
.s2-status--positive .s2-status__dot{background:var(--positive-visual);}
.s2-status--negative .s2-status__dot{background:var(--negative-visual);}
.s2-status--notice .s2-status__dot{background:var(--notice-visual);}
.s2-status--yellow .s2-status__dot{background:var(--spectrum-yellow-600);}
.s2-status--seafoam .s2-status__dot{background:var(--spectrum-seafoam-700);}
.s2-status--indigo .s2-status__dot{background:var(--spectrum-indigo-800);}
.s2-status--purple .s2-status__dot{background:var(--spectrum-purple-800);}
.s2-status--magenta .s2-status__dot{background:var(--spectrum-magenta-800);}
.s2-status--celery .s2-status__dot{background:var(--spectrum-celery-700);}
`;
let injected = false;
function inject() {
  if (injected || typeof document === 'undefined') return;
  injected = true;
  const s = document.createElement('style');
  s.setAttribute('data-s2', 'statuslight');
  s.textContent = CSS;
  document.head.appendChild(s);
}

/**
 * Spectrum 2 StatusLight — a colored dot + label conveying the state
 * of an entity (online, paused, error, …).
 */
function StatusLight({
  variant = 'neutral',
  children,
  ...rest
}) {
  inject();
  return /*#__PURE__*/React.createElement("span", _extends({
    className: `s2-status s2-status--${variant}`
  }, rest), /*#__PURE__*/React.createElement("span", {
    className: "s2-status__dot"
  }), children);
}
Object.assign(__ds_scope, { StatusLight });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/status/StatusLight.jsx", error: String((e && e.message) || e) }); }

// components/status/Tag.jsx
try { (() => {
function _extends() { return _extends = Object.assign ? Object.assign.bind() : function (n) { for (var e = 1; e < arguments.length; e++) { var t = arguments[e]; for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]); } return n; }, _extends.apply(null, arguments); }
const CSS = `
.s2-tag{
  display:inline-flex;align-items:center;gap:6px;box-sizing:border-box;
  font-family:var(--font-sans);font-size:var(--font-size-ui-sm);color:var(--text-body);
  background:var(--spectrum-gray-100);border:1px solid var(--spectrum-gray-300);
  border-radius:var(--radius-sm);padding:3px 8px;height:24px;white-space:nowrap;max-width:100%;
}
.s2-tag__label{overflow:hidden;text-overflow:ellipsis;}
.s2-tag img,.s2-tag svg{width:14px;height:14px;flex:0 0 auto;border-radius:var(--radius-full);}
.s2-tag__remove{
  -webkit-appearance:none;appearance:none;border:0;background:none;padding:0;margin-inline-start:1px;
  width:16px;height:16px;display:inline-flex;align-items:center;justify-content:center;
  border-radius:var(--radius-full);color:var(--text-neutral-subdued);cursor:pointer;flex:0 0 auto;
}
.s2-tag__remove:hover{background:var(--highlight-active);color:var(--text-neutral);}
.s2-tag__remove svg{width:10px;height:10px;}
.s2-tag--disabled{color:var(--text-disabled);background:var(--spectrum-gray-100);border-color:var(--spectrum-gray-200);}
`;
let injected = false;
function inject() {
  if (injected || typeof document === 'undefined') return;
  injected = true;
  const s = document.createElement('style');
  s.setAttribute('data-s2', 'tag');
  s.textContent = CSS;
  document.head.appendChild(s);
}
const X = /*#__PURE__*/React.createElement("svg", {
  viewBox: "0 0 10 10",
  fill: "none"
}, /*#__PURE__*/React.createElement("path", {
  d: "M1.5 1.5l7 7M8.5 1.5l-7 7",
  stroke: "currentColor",
  strokeWidth: "1.6",
  strokeLinecap: "round"
}));

/**
 * Spectrum 2 Tag — a compact, removable chip representing a selection,
 * filter, or attribute. Pass onRemove to render the clear affordance.
 */
function Tag({
  children,
  icon = null,
  onRemove,
  isDisabled = false,
  ...rest
}) {
  inject();
  return /*#__PURE__*/React.createElement("span", _extends({
    className: `s2-tag${isDisabled ? ' s2-tag--disabled' : ''}`
  }, rest), icon, /*#__PURE__*/React.createElement("span", {
    className: "s2-tag__label"
  }, children), onRemove && !isDisabled && /*#__PURE__*/React.createElement("button", {
    type: "button",
    className: "s2-tag__remove",
    "aria-label": "Remove",
    onClick: onRemove
  }, X));
}
Object.assign(__ds_scope, { Tag });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/status/Tag.jsx", error: String((e && e.message) || e) }); }

// ui_kits/creative_cloud/App.jsx
try { (() => {
/* Creative Cloud UI kit — Projects app (data, grid/list, new-project flow).
   Reads design-system components + window.CCKit shell, publishes window.CCApp. */
const {
  Card,
  Badge,
  StatusLight,
  Tag,
  Button,
  TextField,
  RadioGroup,
  Radio,
  Tabs,
  Avatar
} = window.Spectrum2DesignSystem_b6d1b3;
const {
  useState
} = React;
const ILL = n => `../../assets/illustrations/${n}.svg`;
const SEED = [{
  id: 1,
  title: 'Spring campaign',
  type: 'Design',
  edited: '2 hours ago',
  status: ['positive', 'Live'],
  art: 'megaphone'
}, {
  id: 2,
  title: 'Q2 brand report',
  type: 'Document',
  edited: 'Yesterday',
  status: ['notice', 'Draft'],
  art: 'bar-chart'
}, {
  id: 3,
  title: 'Product launch film',
  type: 'Video',
  edited: '3 days ago',
  status: ['informative', 'Rendering'],
  art: 'filmstrip'
}, {
  id: 4,
  title: 'Holiday shop',
  type: 'Web',
  edited: 'Last week',
  status: ['positive', 'Live'],
  art: 'shopping-cart'
}, {
  id: 5,
  title: 'Audience insights',
  type: 'Data',
  edited: 'Last week',
  status: ['neutral', 'Archived'],
  art: 'pie-chart'
}, {
  id: 6,
  title: 'Team offsite',
  type: 'Design',
  edited: '2 weeks ago',
  status: ['positive', 'Live'],
  art: 'fireworks'
}];
const TABS = [{
  id: 'all',
  label: 'All projects'
}, {
  id: 'recent',
  label: 'Recent'
}, {
  id: 'shared',
  label: 'Shared'
}, {
  id: 'archived',
  label: 'Archived'
}];
function NewProjectDialog({
  onClose,
  onCreate
}) {
  const [name, setName] = useState('');
  const [type, setType] = useState('design');
  const submit = () => {
    if (name.trim()) onCreate(name.trim(), type);
  };
  return /*#__PURE__*/React.createElement("div", {
    className: "cc-overlay",
    onClick: onClose
  }, /*#__PURE__*/React.createElement("div", {
    className: "cc-dialog",
    onClick: e => e.stopPropagation()
  }, /*#__PURE__*/React.createElement("h2", {
    className: "cc-dialog__title"
  }, "Create a new project"), /*#__PURE__*/React.createElement("div", {
    className: "cc-dialog__field"
  }, /*#__PURE__*/React.createElement(TextField, {
    label: "Project name",
    placeholder: "Untitled project",
    value: name,
    onChange: setName,
    isRequired: true,
    autoFocus: true
  })), /*#__PURE__*/React.createElement("div", {
    className: "cc-dialog__field"
  }, /*#__PURE__*/React.createElement(RadioGroup, {
    label: "Type",
    value: type,
    onChange: setType,
    orientation: "horizontal"
  }, /*#__PURE__*/React.createElement(Radio, {
    value: "design"
  }, "Design"), /*#__PURE__*/React.createElement(Radio, {
    value: "document"
  }, "Document"), /*#__PURE__*/React.createElement(Radio, {
    value: "video"
  }, "Video"), /*#__PURE__*/React.createElement(Radio, {
    value: "web"
  }, "Web"))), /*#__PURE__*/React.createElement("div", {
    className: "cc-dialog__foot"
  }, /*#__PURE__*/React.createElement(Button, {
    variant: "secondary",
    fillStyle: "outline",
    onPress: onClose
  }, "Cancel"), /*#__PURE__*/React.createElement(Button, {
    variant: "accent",
    onPress: submit,
    isDisabled: !name.trim()
  }, "Create project"))));
}
function ProjectCard({
  p,
  selected,
  onSelect
}) {
  return /*#__PURE__*/React.createElement(Card, {
    image: ILL(p.art),
    title: p.title,
    isSelectable: true,
    isSelected: selected,
    onPress: () => onSelect(p.id),
    description: p.type + ' · ' + p.edited,
    footer: /*#__PURE__*/React.createElement("div", {
      className: "cc-cardmeta"
    }, /*#__PURE__*/React.createElement(StatusLight, {
      variant: p.status[0]
    }, p.status[1]), /*#__PURE__*/React.createElement("span", {
      className: "cc-meta-dim"
    }, p.type))
  });
}
function App() {
  const [section, setSection] = useState('projects');
  const [tab, setTab] = useState('all');
  const [view, setView] = useState('grid');
  const [query, setQuery] = useState('');
  const [projects, setProjects] = useState(SEED);
  const [selected, setSelected] = useState(null);
  const [dialog, setDialog] = useState(false);
  const ARTS = ['rocket', 'cloud-upload', 'heart', 'home', 'shapes', 'brand'];
  const create = (name, type) => {
    const id = Date.now();
    setProjects(ps => [{
      id,
      title: name,
      type: type[0].toUpperCase() + type.slice(1),
      edited: 'Just now',
      status: ['notice', 'Draft'],
      art: ARTS[ps.length % ARTS.length]
    }, ...ps]);
    setSelected(id);
    setDialog(false);
  };
  let shown = projects.filter(p => p.title.toLowerCase().includes(query.toLowerCase()));
  if (tab === 'archived') shown = shown.filter(p => p.status[1] === 'Archived');else if (tab !== 'all') shown = shown.filter(p => p.status[1] !== 'Archived');
  return /*#__PURE__*/React.createElement("div", {
    className: "cc-app"
  }, /*#__PURE__*/React.createElement(window.CCKit.Sidebar, {
    section: section,
    onSection: setSection
  }), /*#__PURE__*/React.createElement("div", {
    className: "cc-main"
  }, /*#__PURE__*/React.createElement(window.CCKit.TopBar, {
    title: "Projects",
    query: query,
    onQuery: setQuery,
    view: view,
    onView: setView,
    onNew: () => setDialog(true)
  }), /*#__PURE__*/React.createElement("div", {
    className: "cc-body"
  }, /*#__PURE__*/React.createElement("div", {
    className: "cc-tabs"
  }, /*#__PURE__*/React.createElement(Tabs, {
    isEmphasized: true,
    items: TABS,
    selectedKey: tab,
    onChange: setTab
  })), shown.length === 0 ? /*#__PURE__*/React.createElement("div", {
    className: "cc-empty"
  }, /*#__PURE__*/React.createElement("img", {
    src: ILL('search'),
    alt: ""
  }), /*#__PURE__*/React.createElement("div", null, "No projects match \"", query, "\".")) : view === 'grid' ? /*#__PURE__*/React.createElement("div", {
    className: "cc-grid"
  }, shown.map(p => /*#__PURE__*/React.createElement(ProjectCard, {
    key: p.id,
    p: p,
    selected: selected === p.id,
    onSelect: setSelected
  }))) : /*#__PURE__*/React.createElement("div", {
    className: "cc-list"
  }, shown.map(p => /*#__PURE__*/React.createElement("div", {
    key: p.id,
    className: `cc-list__row${selected === p.id ? ' is-sel' : ''}`,
    onClick: () => setSelected(p.id)
  }, /*#__PURE__*/React.createElement("div", {
    className: "cc-list__name"
  }, /*#__PURE__*/React.createElement("span", {
    className: "cc-list__thumb",
    style: {
      backgroundImage: `url(${ILL(p.art)})`
    }
  }), p.title), /*#__PURE__*/React.createElement("span", {
    className: "cc-meta-dim"
  }, p.type), /*#__PURE__*/React.createElement("span", {
    className: "cc-meta-dim"
  }, p.edited), /*#__PURE__*/React.createElement(StatusLight, {
    variant: p.status[0]
  }, p.status[1])))))), dialog && /*#__PURE__*/React.createElement(NewProjectDialog, {
    onClose: () => setDialog(false),
    onCreate: create
  }));
}
window.CCApp = App;
})(); } catch (e) { __ds_ns.__errors.push({ path: "ui_kits/creative_cloud/App.jsx", error: String((e && e.message) || e) }); }

// ui_kits/creative_cloud/Shell.jsx
try { (() => {
function _extends() { return _extends = Object.assign ? Object.assign.bind() : function (n) { for (var e = 1; e < arguments.length; e++) { var t = arguments[e]; for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]); } return n; }, _extends.apply(null, arguments); }
/* Creative Cloud UI kit — Shell (Sidebar + TopBar).
   Loaded as a Babel script by index.html; reads components off the
   design-system namespace and publishes parts on window.CCKit. */
const {
  Avatar,
  Button,
  ActionButton,
  Meter,
  Badge
} = window.Spectrum2DesignSystem_b6d1b3;
const {
  useState,
  useEffect
} = React;

/* Inline-SVG icon that inherits currentColor (CSS mask is unreliable here). */
const _iconCache = {};
function Icon({
  name,
  size = 20,
  color
}) {
  const [html, setHtml] = useState(_iconCache[name] || '');
  useEffect(() => {
    if (_iconCache[name]) {
      setHtml(_iconCache[name]);
      return;
    }
    let live = true;
    fetch(`../../assets/icons/${name}.svg`).then(r => r.text()).then(t => {
      t = t.replace(/fill="[^"]*"/g, 'fill="currentColor"');
      _iconCache[name] = t;
      if (live) setHtml(t);
    });
    return () => {
      live = false;
    };
  }, [name]);
  return /*#__PURE__*/React.createElement("span", {
    className: "cc-ic",
    style: {
      width: size,
      height: size,
      color
    },
    dangerouslySetInnerHTML: {
      __html: html
    }
  });
}
function NavItem({
  icon,
  label,
  badge,
  active,
  onClick
}) {
  return /*#__PURE__*/React.createElement("button", {
    className: `cc-nav__item${active ? ' is-active' : ''}`,
    onClick: onClick
  }, /*#__PURE__*/React.createElement(Icon, {
    name: icon,
    size: 20
  }), /*#__PURE__*/React.createElement("span", {
    className: "cc-nav__label"
  }, label), badge != null && /*#__PURE__*/React.createElement("span", {
    className: "cc-nav__badge"
  }, badge));
}
function Sidebar({
  section,
  onSection
}) {
  const items = [{
    id: 'home',
    icon: 'home',
    label: 'Home'
  }, {
    id: 'files',
    icon: 'folder',
    label: 'Files'
  }, {
    id: 'projects',
    icon: 'view-grid',
    label: 'Projects'
  }, {
    id: 'shared',
    icon: 'user-group',
    label: 'Shared with you',
    badge: 3
  }, {
    id: 'deleted',
    icon: 'delete',
    label: 'Deleted'
  }];
  return /*#__PURE__*/React.createElement("aside", {
    className: "cc-sidebar"
  }, /*#__PURE__*/React.createElement("div", {
    className: "cc-brand"
  }, /*#__PURE__*/React.createElement("span", {
    className: "cc-brand__mark"
  }), /*#__PURE__*/React.createElement("span", {
    className: "cc-brand__wm"
  }, "Spectrum ", /*#__PURE__*/React.createElement("b", null, "2"))), /*#__PURE__*/React.createElement("nav", {
    className: "cc-nav"
  }, items.map(it => /*#__PURE__*/React.createElement(NavItem, _extends({
    key: it.id
  }, it, {
    active: section === it.id,
    onClick: () => onSection(it.id)
  })))), /*#__PURE__*/React.createElement("div", {
    className: "cc-storage"
  }, /*#__PURE__*/React.createElement(Meter, {
    label: "Cloud storage",
    value: 62,
    valueLabel: "62 GB of 100 GB",
    variant: "informative"
  }), /*#__PURE__*/React.createElement(Button, {
    variant: "secondary",
    size: "S",
    fillStyle: "outline"
  }, "Manage")));
}
function TopBar({
  title,
  query,
  onQuery,
  view,
  onView,
  onNew
}) {
  return /*#__PURE__*/React.createElement("header", {
    className: "cc-topbar"
  }, /*#__PURE__*/React.createElement("h1", {
    className: "cc-topbar__title"
  }, title), /*#__PURE__*/React.createElement("div", {
    className: "cc-search"
  }, /*#__PURE__*/React.createElement("span", {
    className: "cc-search__icon"
  }, /*#__PURE__*/React.createElement(Icon, {
    name: "search",
    size: 16
  })), /*#__PURE__*/React.createElement("input", {
    className: "cc-search__input",
    placeholder: "Search projects",
    value: query,
    onChange: e => onQuery(e.target.value)
  })), /*#__PURE__*/React.createElement("div", {
    className: "cc-topbar__actions"
  }, /*#__PURE__*/React.createElement(ActionButton, {
    isQuiet: true,
    isSelected: view === 'grid',
    onPress: () => onView('grid'),
    "aria-label": "Grid view",
    icon: /*#__PURE__*/React.createElement(Icon, {
      name: "view-grid",
      size: 18
    })
  }), /*#__PURE__*/React.createElement(ActionButton, {
    isQuiet: true,
    isSelected: view === 'list',
    onPress: () => onView('list'),
    "aria-label": "List view",
    icon: /*#__PURE__*/React.createElement(Icon, {
      name: "view-list",
      size: 18
    })
  }), /*#__PURE__*/React.createElement("span", {
    className: "cc-divider"
  }), /*#__PURE__*/React.createElement(ActionButton, {
    isQuiet: true,
    "aria-label": "Notifications",
    icon: /*#__PURE__*/React.createElement(Icon, {
      name: "bell",
      size: 18
    })
  }), /*#__PURE__*/React.createElement(Button, {
    variant: "accent",
    onPress: onNew,
    icon: /*#__PURE__*/React.createElement(Icon, {
      name: "add",
      size: 18,
      color: "#fff"
    })
  }, "New project"), /*#__PURE__*/React.createElement(Avatar, {
    initials: "AL",
    alt: "Ana Lee",
    size: "M"
  })));
}
window.CCKit = {
  Sidebar,
  TopBar
};
})(); } catch (e) { __ds_ns.__errors.push({ path: "ui_kits/creative_cloud/Shell.jsx", error: String((e && e.message) || e) }); }

__ds_ns.ActionButton = __ds_scope.ActionButton;

__ds_ns.Button = __ds_scope.Button;

__ds_ns.Avatar = __ds_scope.Avatar;

__ds_ns.Card = __ds_scope.Card;

__ds_ns.Tabs = __ds_scope.Tabs;

__ds_ns.Checkbox = __ds_scope.Checkbox;

__ds_ns.RadioGroup = __ds_scope.RadioGroup;

__ds_ns.Radio = __ds_scope.Radio;

__ds_ns.Switch = __ds_scope.Switch;

__ds_ns.TextField = __ds_scope.TextField;

__ds_ns.Badge = __ds_scope.Badge;

__ds_ns.InlineAlert = __ds_scope.InlineAlert;

__ds_ns.Meter = __ds_scope.Meter;

__ds_ns.StatusLight = __ds_scope.StatusLight;

__ds_ns.Tag = __ds_scope.Tag;

})();
