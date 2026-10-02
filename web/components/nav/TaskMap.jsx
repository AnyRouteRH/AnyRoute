import { GROUPS, TASKS } from '../../lib/site-map';
import SearchButton from './SearchButton';
import './nav.css';

export default function TaskMap() {
  return <section className="task-map section" aria-labelledby="task-map-title"><div className="container">
    <div className="section-head"><div><span className="eyebrow tick">Find your next step</span><h2 id="task-map-title">What do you want to do?</h2></div><SearchButton homepage /></div>
    <div className="task-map-grid">{GROUPS.map(group => <div className="task-map-card" key={group.id}><h3>{group.title}</h3><ul>{TASKS.filter(task => task.group === group.id && task.featured).map(task => <li key={task.id}><a href={task.href}><strong>{task.title}<b aria-hidden="true">↗</b></strong><span>{task.description}</span></a></li>)}</ul></div>)}</div>
  </div></section>;
}
