const WHM_HOST = process.env.WHM_HOST;
const WHM_USER = process.env.WHM_USER;
const WHM_TOKEN = process.env.WHM_TOKEN;

async function test() {
    // 1. Get session URL
    console.log("Getting session...");
    const sessionRes = await fetch(`${WHM_HOST}/json-api/create_user_session?api.version=1&user=jackprof&service=cpaneld`, {
        headers: { Authorization: `whm ${WHM_USER}:${WHM_TOKEN}` }
    });
    const sessionData = await sessionRes.json();
    const loginUrl = sessionData.data.url;
    console.log("Login URL:", loginUrl);

    // 2. Hit login URL to get cookie
    console.log("Hitting login URL...");
    const loginResp = await fetch(loginUrl, { redirect: "manual" });
    const setCookieHeader = loginResp.headers.get('set-cookie');
    console.log("Cookies:", setCookieHeader);

    if (!setCookieHeader) {
        console.log("No cookie found!");
        return;
    }

    // Parse cpsession cookie
    const cookies = setCookieHeader.split(', ').map(c => c.split(';')[0]);
    const cpsessionCookie = cookies.find(c => c.startsWith('cpsession='));

    if (!cpsessionCookie) {
        console.log("No cpsession cookie found!");
        return;
    }

    console.log("Cookie value:", cpsessionCookie);

    // 3. Call Softaculous API
    const match = loginUrl.match(/\/cpsess\d+\//);
    const cpsess = match ? match[0] : "/";
    const cpanelHost = loginUrl.split("/")[2];
    const softUrl = `https://${cpanelHost}${cpsess}frontend/jupiter/softaculous/index.php?act=installations&api=json`;
    console.log("Softaculous URL:", softUrl);

    const softResp = await fetch(softUrl, {
        headers: {
            "Cookie": cpsessionCookie
        }
    });

    console.log("Softaculous Status:", softResp.status);
    const softText = await softResp.text();
    console.log("Softaculous Response starting with:", softText.substring(0, 500));
}
test().catch(console.error);
