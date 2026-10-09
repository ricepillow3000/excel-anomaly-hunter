import { VIEWS } from "../constants/index.js";
import { state } from "../hooks/use-state.js";

export const $ = (id) => document.getElementById(id);
export const show = (id, on = true) => ($(id).hidden = !on);
export const only = (id) => ((state.view = id), VIEWS.forEach((v) => show(v, v === id))); // switch page
