const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

export const activityInterval = 125;
let currentFrame = frames[0];

export function currentActivityFrame() {
  return currentFrame;
}

/** @param {number} now */
export function activityFrame(now) {
  return frames[Math.floor(now / activityInterval) % frames.length];
}

/** @param {Document} root */
export function watchActivity(root) {
  const motion = matchMedia("(prefers-reduced-motion: reduce)");
  const visible = new Set(root.querySelectorAll(".spinner"));
  visible.clear();
  let nodes = new Set(visible);
  let timer = 0;

  const tick = () => {
    currentFrame = motion.matches ? frames[0] : activityFrame(Date.now());
    for (const node of visible) {
      if (node.textContent !== currentFrame) node.textContent = currentFrame;
    }
  };

  const sync = () => {
    if (root.hidden || motion.matches || visible.size === 0) {
      clearInterval(timer);
      timer = 0;
      if (!root.hidden) tick();
      return;
    }
    tick();
    if (!timer) timer = setInterval(tick, activityInterval);
  };

  const intersections = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (entry.isIntersecting && nodes.has(entry.target)) visible.add(entry.target);
      else visible.delete(entry.target);
    }
    sync();
  });

  const collect = () => {
    const next = new Set(root.querySelectorAll(".spinner"));
    for (const node of nodes) {
      if (!next.has(node)) {
        intersections.unobserve(node);
        visible.delete(node);
      }
    }
    for (const node of next) {
      if (!nodes.has(node)) {
        node.setAttribute("aria-hidden", "true");
        intersections.observe(node);
      }
    }
    nodes = next;
    sync();
  };

  /** @param {Node} node */
  const containsSpinner = (node) =>
    node instanceof Element && (nodes.has(node) || node.matches(".spinner") || node.querySelector(".spinner") !== null);

  const observer = new MutationObserver((records) => {
    if (
      records.some((record) =>
        record.type === "attributes"
          ? containsSpinner(record.target)
          : [...record.addedNodes, ...record.removedNodes].some(containsSpinner),
      )
    )
      collect();
  });
  observer.observe(root.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["class"],
  });
  root.addEventListener("visibilitychange", sync);
  motion.addEventListener("change", sync);
  collect();

  return () => {
    clearInterval(timer);
    observer.disconnect();
    intersections.disconnect();
    root.removeEventListener("visibilitychange", sync);
    motion.removeEventListener("change", sync);
  };
}
