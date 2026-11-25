/** Full-page navigation (a seam for tests; jsdom cannot navigate). */
export const browser = {
  assign(url: string): void {
    window.location.assign(url);
  },
};
