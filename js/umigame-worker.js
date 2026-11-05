// Computes the Umigame numbers of every book position off the main thread.
// In: the book file as an ArrayBuffer. Out: { progress } messages, then { umi } (Float64Array).
import { Book } from './book.js';

self.onmessage = (e) => {
  try {
    const book = new Book(e.data);
    let done;
    do {
      done = book.umigameStep(250);
      self.postMessage({ progress: done });
    } while (done < 1);
    self.postMessage({ umi: book.umi }, [book.umi.buffer]);
  } catch (err) {
    self.postMessage({ error: String(err && err.message || err) });
  }
};
