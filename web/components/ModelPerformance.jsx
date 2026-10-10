// E150
import { performanceLabels } from "../lib/model-performance.js";
import s from "./ModelPerformance.module.css";

export default function ModelPerformance({ model }) {
  return <dl className={s.readings} aria-label="Recent model performance">{performanceLabels(model).map(({ key, title, text }) => <div key={key}><dt>{title}</dt><dd>{text}</dd></div>)}</dl>;
}
