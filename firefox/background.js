
const EVENT_SWITCH_TO_NEWLY_OPENED_TAB = 'switch-to-newly-opened-tab';
const EVENT_CLOSE_NEWLY_OPENED_TAB = 'close-newly-opened-tab';

// How many screenshots per page should we take:
const MAX_SCREENSHOTS = 7;

// peek() will register a loaded-listener
// for the newly created tab. One loaded-listener
// per tab.
var loadedListenerForTab = {};

// Run the extension:
main();


//////////////////////////
/////// Functions ////////
//////////////////////////

/**
 * Register runtime listener
 * For switching to the newly created tab.
 * For closing the newly creatd tab.
 */
function registerRuntimeListener() {
    var runtimeListener = (payload) => {
        if (payload && payload.message) {
            switch(payload.message) {
                case EVENT_SWITCH_TO_NEWLY_OPENED_TAB:
                    browser.tabs.update(payload.tabId, {
                        active: true
                    });
                break;
                case EVENT_CLOSE_NEWLY_OPENED_TAB:
                    browser.tabs.remove(payload.tabId);
                break;
            }
        }
    };
    
    browser.runtime.onMessage.addListener(runtimeListener);    
}

/**
 * We listen to DOM Content Loaded, this has
 * a lower latency then waiting for 
 * tab.status == complete events. 
 * 
 * Low latency is important for our user 
 * experience, otherwise this won't be Quick Peek.
 */
function registerDomContentLoadedListener() { 
    var domContentLoadedListener = data => {
        if (data.frameId !== 0) {
            return;
        }
        var id = `${data.windowId}-${data.tabId}`;
    
        if (id in loadedListenerForTab) {
            loadedListenerForTab[id](data);
        }
    }
    
    browser.webNavigation.onDOMContentLoaded.addListener(domContentLoadedListener);    
}

/**
 * Peek a url.
 * 
 * - Create a new (inactive) tab
 * - Load the url in the this new tab.
 * - Add a preview container to the current tab
 * - When the tab has loaded it's content we will
 *   capture it's viewPort content.
 *   To capture content below the fold we scroll
 *   the page and capture the viewPort again.
 */
async function peek(url) {

    // Google employs a redirect-url mechanism, 
    // links on the page go to google.com/url?...url=xxx
    // For even lower latency we open the referred to page directly.
    var urlQueryParam = new URL(url).searchParams.get('url');
    if (urlQueryParam && urlQueryParam.match(/https?:\/\//)) {
        url = urlQueryParam;
    }

    var newTab = await browser.tabs.create({
        url: url,
        active: false
    });

    // Create the preview container on the CURRENT Page:
    browser.tabs.executeScript({
        code: `
        function close() {
            document.body.removeChild(container);
        }
        function abortTab() {
            browser.runtime.sendMessage({
                message: '${EVENT_CLOSE_NEWLY_OPENED_TAB}',
                tabId: ${newTab.id}
            });
            
            close();
        }

        function openTab() {
            browser.runtime.sendMessage({
                message: '${EVENT_SWITCH_TO_NEWLY_OPENED_TAB}',
                tabId: ${newTab.id}
            });
            
            close();
        }

        var existing = document.getElementById('peek-unit');
        existing && document.body.removeChild(existing);
        var container = document.createElement('div');
        container.id = 'peek-unit';
        container.style.position = 'fixed';
        container.style.zIndex = 1000;
        container.style.background = 'white';
        container.style.bottom = 0;
        container.style.right = 0;
        container.style.width = '60%';
        container.style.height = '70%';
        container.style.overflow = 'auto';
        container.style.boxShadow = '0 0 20px rgba(0,0,0,0.5)';
        container.addEventListener('click', e => {
            openTab()
        });

        var title = document.createElement('h1');
        title.style.fontSize = '14pt';
        title.style.padding = '10px';
        title.style.whiteSpace = 'nowrap';
        title.style.overflow = 'hidden';
        title.style.textOverflow = 'ellipsis';
        title.innerText = 'Loading..';
        container.append(title);

        document.body.append(container);
        document.body.addEventListener('keydown', e => {
            // ESCAPE or Q to abort the tab.
            if (e.which == 27 || e.which === 81) {
                abortTab();
            }
        });
        var closeListener = e => {
            close();
            document.body.removeEventListener('click', closeListener)
        };
        document.body.addEventListener('click', closeListener);

        // When peeking from a sidebar
        // we want the window that contains this popup 
        // to gain focus so we can respond to keyboard signals.
        // window.focus() - does not work.

        `
    })

    // Clear the preview container, 
    // but do keep the title element.
    var emptyContainer = () => {
        browser.tabs.executeScript({
            code: `
            var container = document.getElementById('peek-unit');

            container.innerHTML = '';

            var title = document.createElement('h1');
            title.style.fontSize = '14pt';
            title.style.padding = '10px';
            title.style.whiteSpace = 'nowrap';
            title.style.overflow = 'hidden';
            title.style.textOverflow = 'ellipsis';
            title.innerText = 'Loading..';
            container.append(title);
            `
        });  
    };

    // Add a screenshot to the preview container.
    var appendScreenshot = capturedData => {
        return browser.tabs.executeScript({
            code: `

            var container = document.getElementById('peek-unit');
            var img = document.createElement('img');
            img.src = "${capturedData}";
            img.style.width = '100%';
            img.style.border = 'none';
            img.style.padding = 0;
            img.style.margin = 0;
            img.style.float = 'left'; // fixes 1 px spacing

            container.append(img);
            `
        });
    }

    // Sets the preview container title.
    var setTitle = title => {
        return browser.tabs.executeScript({
            code: `

            var title = document.querySelector('#peek-unit h1');
            title.innerText = ${JSON.stringify(title)};
            `
        });
    }

    emptyContainer();

    setTitle(url);

    // In one peek the tab may load few urls
    // because of redirects, cookie walls, etc.
    // Whenever the a new page is loaded inside the
    // tab we need to capture its content again.

    var lastTabUrl = null;

    loadedListenerForTab[`${newTab.windowId}-${newTab.id}`] = async (data) => {

        emptyContainer();
    
        // console.log('inserting css');
    
        setTitle(data.url);

        await browser.tabs.insertCSS(newTab.id, {
            code: `
            body.zoom {
                -moz-transform: scale(1.5);
                -moz-transform-origin: 0 0;
                width:66%;
            }
            `   
        });

        // console.log('inserted css');

        await browser.tabs.executeScript(newTab.id, {
            code: `document.body.classList.add('zoom');`
        });
    
        // console.log("capturing screenshot");

        // Above the FOLD capture:
        var capture = await browser.tabs.captureTab(newTab.id);

        appendScreenshot(capture);


        // Start to capture content below the fold.
        // but limit this to 10 iterations, because
        // we'll click on the preview if we deem it
        // interesting enough.

        
        var iterations = 0;
        while(true) { 
            if (lastTabUrl && lastTabUrl !== data.url) {
                // abort, because the url was changed.
                return;
            }
            lastTabUrl = data.url;

            iterations++;
    
            // set scroll to bottom
            // console.log("Scrolling to bottom");
            var [remainingPixelsOnPage] = await browser.tabs.executeScript(newTab.id, {
                code: `
                    window.scrollTo(0, window.pageYOffset + window.innerHeight);
    
                    var h = document.body.scrollHeight || document.body.clientHeight;
    
                    var result =  h - window.pageYOffset - window.innerHeight;
                    /* return: */ result;
                `
            });
    
            // console.log('result', res);
    
            capture = await browser.tabs.captureTab(newTab.id);
    
            appendScreenshot(capture);
    
            if (iterations >= MAX_SCREENSHOTS) {
                console.log(`Bailing long page, ${iterations} screens should be enough to get the gist..`);
                break;
            }

            // Check if there is enough 
            if (remainingPixelsOnPage < 100) {
                break;
            }
        }
        
        // Reset scroll to top.
        var res = await browser.tabs.executeScript(newTab.id, {
            code: `
                document.body.classList.remove('zoom');
                window.scrollTo(0, 0);
            `
        });   
    }
}

function registerContextmenu() {
    browser.contextMenus.create({
        title: "P&eek",
        contexts: ["link"],
        onclick(info) {
            peek(info.linkUrl);
        }
    })
}

function main() {
    registerRuntimeListener();
    registerDomContentLoadedListener();
    registerContextmenu();
}
