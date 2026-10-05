import '@fontsource-variable/host-grotesk';
import '@fontsource-variable/martian-mono';
import './globals.css';
import './sections.css';
import './pages.css';
export const metadata={title:'Anyroute — Any model. One key. Paid per call.',description:'The inference router on Robinhood Chain: $ANYR and stock-token payments, signed receipts, encrypted chat, agent rulebooks and a network open for early hosts.',manifest:'/manifest.webmanifest',appleWebApp:{capable:true,title:'Anyroute',statusBarStyle:'black-translucent'},icons:{apple:'/pwa/apple-touch-icon.png',icon:[{url:'/brand/anyroute-mark.svg',type:'image/svg+xml'},{url:'/brand/anyroute-symbol.png',type:'image/png'}]}};
export const viewport={themeColor:'#0b0c0b',viewportFit:'cover'};
export default function RootLayout({children}){return <html lang="en" suppressHydrationWarning><head><script dangerouslySetInnerHTML={{__html:"document.documentElement.classList.add('js')"}}/></head><body>{children}</body></html>}
