// What a failure says on screen (AH-110). Every catch put e.message there, so Office's and the browser's own words
// reached the user: "Something went wrong: InvalidOperationInCellEditMode" while a cell was being typed in, "Cannot read
// properties of undefined (reading 'values')" from a bug of ours. Our own sentences (the engine's, the network's, built in
// services/api.js) are said as they are; Excel's codes get a sentence each; anything else one plain sentence, and the
// detail goes to the console for whoever debugs it.

// An error whose message is a sentence of ours, fit to show as it is
export const ours = (message) => Object.assign(new Error(message), { ours: true });
export const isOurs = (e) => e?.ours === true;

// Office.js error codes (OfficeExtension.Error.code) a person can act on
const OFFICE = {
  InvalidOperationInCellEditMode: "Excel is busy editing a cell. Press Enter or Esc, then try again.",
  ItemNotFound: "The sheet or cells this was about are gone (deleted, renamed or moved). Click Find problems to check the sheet again.",
};

// -> the sentence to show. lead names what failed ("Accept failed"): "lead: our words", or "lead. Try again..."
export function plainError(e, lead = "Something went wrong") {
  if (isOurs(e)) return `${lead}: ${e.message}`;
  console.error(e);
  return Object.hasOwn(OFFICE, String(e?.code)) ? OFFICE[e.code]
    : `${lead}. Try again; if it keeps happening, close the pane and open it again.`;
}
