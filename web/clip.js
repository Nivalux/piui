// @ts-check

/** @param {string} text */
export async function toClipboard(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return selectAndCopy(text);
  }
}

/** @param {string} text */
function selectAndCopy(text) {
  const holder = /** @type {HTMLTextAreaElement} */ (document.createElement("textarea"));
  holder.className = "copy-holder";
  holder.value = text;
  document.body.append(holder);
  holder.select();
  const copied = document.execCommand("copy");
  holder.remove();
  return copied;
}
