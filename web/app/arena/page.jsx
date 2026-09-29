import PageFrame from '../../components/PageFrame';
import Arena from '../../components/Arena';
export const metadata={title:'Model Arena — Anyroute',description:'Race one prompt across two to four models, live: time to first token, total time, cost and a signed receipt for every answer.'};
export default function ArenaPage(){return <PageFrame><main id="content"><Arena/></main></PageFrame>}
