// E151
import { modelPageHref } from "../lib/model-page.js";
export default function ModelPageLink({ model }) {
  return <a className="text-button" href={modelPageHref(model.id)}>View model page →</a>;
}
