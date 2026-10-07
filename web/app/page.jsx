import NewModelsHome from "../components/NewModels"; // C131
import PageFrame from '../components/PageFrame';
import Hero from '../components/Hero';
import TaskMap from '../components/nav/TaskMap';
import Ticker from '../components/Ticker';
import Stats from '../components/Stats';
import FeatureGrid from '../components/FeatureGrid';
import RouteModes from '../components/RouteModes';
import HowItWorks from '../components/HowItWorks';
import Accountability from '../components/Accountability';
import Gateway from '../components/Gateway';
import Privacy from '../components/Privacy';
import {CaseStudy,Roadmap,About,Developers} from '../components/Extensions';
export default function Home(){return <PageFrame><main id="content"><Hero/><TaskMap/><Ticker/><NewModelsHome/><Stats/><FeatureGrid/><RouteModes/><HowItWorks/><Accountability/><Gateway/><Privacy/><CaseStudy/><Roadmap/><About/><Developers/></main></PageFrame>}
