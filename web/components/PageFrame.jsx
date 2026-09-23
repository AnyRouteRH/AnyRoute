import {Header,MotionManager} from './UI';
import Footer from './Footer';

export default function PageFrame({children,footer=true,app=false}){return <div className="anyroute"><Header app={app}/>{children}{footer&&<Footer/>}<MotionManager/></div>}
