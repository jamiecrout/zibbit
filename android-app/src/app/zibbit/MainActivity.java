package app.zibbit;

import android.app.Activity;
import android.app.AlertDialog;
import android.app.PendingIntent;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.pm.PackageInstaller;
import android.provider.Settings;
import android.app.UiModeManager;
import android.content.pm.PackageManager;
import android.content.res.Configuration;
import android.os.Handler;
import android.os.SystemClock;
import android.view.KeyEvent;
import android.webkit.ValueCallback;
import android.widget.Toast;
import android.content.SharedPreferences;
import android.graphics.Color;
import android.graphics.Typeface;
import android.text.InputType;
import android.view.Gravity;
import android.view.inputmethod.EditorInfo;
import android.view.inputmethod.InputMethodManager;
import android.webkit.WebResourceResponse;
import android.widget.ScrollView;
import android.widget.Button;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.TextView;
import android.net.Uri;
import android.os.Bundle;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowManager;
import android.webkit.CookieManager;
import android.webkit.RenderProcessGoneDetail;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;

public class MainActivity extends Activity {
    private static final String PREFS = "dock";
    private static final String KEY_URL = "url";     // the one used last
    private static final String KEY_LIST = "servers"; // every address entered, one per line

    private String startUrl;   // e.g. https://tv.example.com/ , chosen on first run
    private String host;
    private int port;
    private String scheme;

    private LinearLayout setup, serverRows;
    private EditText addressBox;
    private TextView setupNote;
    private boolean connected;
    private WebView web;
    private FrameLayout root;
    private boolean isTv;      // a TV (Android TV or Fire TV): opens the TV page and takes remote-control keys
    private long lastBack;
    private View customView;
    private WebChromeClient.CustomViewCallback customCallback;

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        isTv = detectTv();
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);

        root = new FrameLayout(this);
        root.setBackgroundColor(0xFF0F1D2C);
        web = new WebView(this);
        web.setBackgroundColor(0xFF0F1D2C);
        root.addView(web, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        buildSetup();
        setContentView(root);

        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(false);
        s.setSupportMultipleWindows(false);
        // Lets the Zibbit page know it is running in this app, so its Settings can offer "Change server"
        s.setUserAgentString(s.getUserAgentString() + " ZibbitApp/3.0" + (isTv ? " ZibbitTV" : ""));
        web.setFocusable(true);
        web.setFocusableInTouchMode(true);

        CookieManager.getInstance().setAcceptCookie(true);

        web.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView v, WebResourceRequest r) {
                Uri u = r.getUrl();
                if ("zibbit".equals(u.getScheme())) { // "Change address" on the error page, and "Change server" / "Check for app update" in the page's Settings
                    if ("update".equals(u.getHost())) checkForUpdate(true); else showStartup();
                    return true;
                }
                // Stay inside the dock: block navigation to any other site.
                return !sameSite(u);
            }

            @Override
            public void onReceivedError(WebView v, WebResourceRequest r, WebResourceError e) {
                if (r.isForMainFrame()) showUnreachable(v);
            }

            @Override
            public void onReceivedHttpError(WebView v, WebResourceRequest r, WebResourceResponse e) {
                // A proxy or server answering 5xx for the page itself: show the same screen as "can't reach".
                if (r.isForMainFrame() && e.getStatusCode() >= 500) showUnreachable(v);
            }

            @Override
            public boolean onRenderProcessGone(WebView v, RenderProcessGoneDetail d) {
                // Reload instead of crashing if the WebView renderer is killed.
                recreate();
                return true;
            }
        });

        web.setWebChromeClient(new WebChromeClient() {
            @Override
            public void onShowCustomView(View view, CustomViewCallback cb) {
                if (customView != null) { cb.onCustomViewHidden(); return; }
                customView = view;
                customCallback = cb;
                root.addView(view, new FrameLayout.LayoutParams(
                        ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
                web.setVisibility(View.GONE);
                hideSystemBars(true);
            }

            @Override
            public void onHideCustomView() {
                if (customView == null) return;
                root.removeView(customView);
                customView = null;
                web.setVisibility(View.VISIBLE);
                hideSystemBars(false);
                if (customCallback != null) customCallback.onCustomViewHidden();
                customCallback = null;
            }
        });

        // Open the server used last. The server list only appears on the very first run, or when
        // asked for (Settings > Change server in the page, or "Change address" when it can't be reached).
        String last = getSharedPreferences(PREFS, MODE_PRIVATE).getString(KEY_URL, null);
        if (last != null && problem(last) == null) {
            setSite(last);
            connected = true;
            if (state == null || web.restoreState(state) == null) { // restoring covers a renderer that was killed
                web.loadUrl(entryUrl());
                web.requestFocus();
                checkForUpdate(false);
            }
        } else {
            showStartup();
        }
    }

    private boolean detectTv() {
        UiModeManager um = (UiModeManager) getSystemService(UI_MODE_SERVICE);
        PackageManager pm = getPackageManager();
        return (um != null && um.getCurrentModeType() == Configuration.UI_MODE_TYPE_TELEVISION)
                || pm.hasSystemFeature("android.software.leanback")
                || pm.hasSystemFeature("amazon.hardware.fire_tv");
    }

    /** What to open: the server's home page, or its TV page when this is a TV. */
    private String entryUrl() {
        return isTv ? startUrl + "tv" : startUrl;
    }

    /** A remote has no pointer, so anything pressable has to show where the focus is. */
    private void tvFocusable(final View v, final int normalBg, final int normalFg, final int focusBg) {
        if (!isTv) return;
        v.setFocusable(true);
        v.setOnFocusChangeListener(new View.OnFocusChangeListener() {
            @Override
            public void onFocusChange(View x, boolean has) {
                x.setBackgroundColor(has ? focusBg : normalBg);
                if (x instanceof TextView) ((TextView) x).setTextColor(has ? 0xFF0F1D2C : normalFg);
            }
        });
    }

    private void showUnreachable(WebView v) {
        String html = "<html><body style='margin:0;background:#0F1D2C;color:#E8EEF4;"
                            + "font-family:sans-serif;display:flex;align-items:center;"
                            + "justify-content:center;height:100vh;text-align:center'>"
                            + "<div><h2>Can't reach " + host + "</h2>"
                            + "<p>Check your data connection, then try again.</p>"
                            + "<p><a href='" + entryUrl() + "' style='display:inline-block;"
                            + "padding:18px 40px;background:#4FD1C5;color:#0F1D2C;"
                            + "border-radius:12px;font-size:22px;text-decoration:none'>"
                            + "Try again</a></p>"
                            + "<p><a href='zibbit://change' style='display:inline-block;"
                            + "padding:14px 30px;border:2px solid #4FD1C5;color:#4FD1C5;"
                            + "border-radius:12px;font-size:18px;text-decoration:none'>"
                            + "Change address</a></p></div></body></html>";
        v.loadDataWithBaseURL(startUrl, html, "text/html", "utf-8", null);
    }

    /* ---- the address this app opens ---- */

    private void setSite(String url) {
        Uri u = Uri.parse(url);
        startUrl = url;
        scheme = u.getScheme().toLowerCase();
        host = u.getHost();
        port = u.getPort();
    }

    private boolean sameSite(Uri u) {
        return u.getScheme() != null && u.getHost() != null && host != null
                && scheme.equalsIgnoreCase(u.getScheme()) && host.equalsIgnoreCase(u.getHost())
                && port == u.getPort();
    }

    /** Home-network addresses may use plain http; anything else must be https. */
    private static boolean isHomeHost(String h) {
        if (h == null) return false;
        h = h.toLowerCase();
        if (h.indexOf('.') < 0 || h.endsWith(".local") || h.endsWith(".lan") || h.endsWith(".home")
                || h.endsWith(".internal") || h.endsWith(".home.arpa")) return true;
        if (h.startsWith("10.") || h.startsWith("192.168.") || h.startsWith("127.")) return true;
        if (h.startsWith("172.")) {
            try {
                int b = Integer.parseInt(h.substring(4, h.indexOf('.', 4)));
                return b >= 16 && b <= 31;
            } catch (Exception e) { return false; }
        }
        return false;
    }

    /** Adds a missing https:// and a trailing slash. Returns null when nothing usable was typed. */
    private static String normalize(String in) {
        String t = in == null ? "" : in.trim();
        if (t.isEmpty()) return null;
        if (t.indexOf("://") < 0) {
            String hostPart = t.split("[/:]")[0];
            t = (isHomeHost(hostPart) ? "http://" : "https://") + t;
        }
        if (t.indexOf('/', t.indexOf("://") + 3) < 0) t += "/";
        return t;
    }

    /** Null when the address is fine, otherwise what to tell the person. */
    private static String problem(String url) {
        if (url == null) return "Type the address of your Zibbit page, for example tv.example.com";
        Uri u = Uri.parse(url);
        String sc = u.getScheme();
        if (u.getHost() == null || sc == null || !(sc.equalsIgnoreCase("http") || sc.equalsIgnoreCase("https")))
            return "That doesn't look like a web address.";
        if (sc.equalsIgnoreCase("http") && !isHomeHost(u.getHost()))
            return "Use https:// for addresses outside your home network.";
        return null;
    }

    /* ---- the startup screen: saved servers, connect, exit ---- */

    private java.util.List<String> servers() {
        java.util.List<String> out = new java.util.ArrayList<String>();
        String raw = getSharedPreferences(PREFS, MODE_PRIVATE).getString(KEY_LIST, "");
        for (String x : raw.split("\n")) if (!x.trim().isEmpty() && !out.contains(x.trim())) out.add(x.trim());
        return out;
    }

    private void saveServers(java.util.List<String> l) {
        StringBuilder sb = new StringBuilder();
        for (String x : l) sb.append(x).append('\n');
        getSharedPreferences(PREFS, MODE_PRIVATE).edit().putString(KEY_LIST, sb.toString()).apply();
    }

    private int dp(int v) { return (int) (v * getResources().getDisplayMetrics().density); }

    private Button button(String label, int fg, int bg, int size) {
        Button b = new Button(this);
        b.setText(label);
        b.setTextSize(size);
        b.setAllCaps(false);
        b.setTextColor(fg);
        b.setBackgroundColor(bg);
        tvFocusable(b, bg, fg, 0xFF9EC5FF);
        return b;
    }

    private void buildSetup() {
        int pad = dp(20);
        ScrollView scroll = new ScrollView(this);
        scroll.setBackgroundColor(0xFF0F1D2C);
        setup = new LinearLayout(this);
        setup.setOrientation(LinearLayout.VERTICAL);
        setup.setPadding(pad, pad, pad, pad);
        scroll.addView(setup, new ViewGroup.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));

        TextView title = new TextView(this);
        title.setText("Zibbit");
        title.setTextColor(0xFFE8EEF4);
        title.setTextSize(30);
        title.setTypeface(Typeface.DEFAULT_BOLD);
        setup.addView(title);

        setupNote = new TextView(this);
        setupNote.setTextSize(17);
        setupNote.setPadding(0, dp(6), 0, dp(10));
        setup.addView(setupNote);

        serverRows = new LinearLayout(this);
        serverRows.setOrientation(LinearLayout.VERTICAL);
        setup.addView(serverRows);

        addressBox = new EditText(this);
        addressBox.setHint("tv.example.com");
        addressBox.setHintTextColor(0xFF6F8296);
        addressBox.setTextColor(0xFFE8EEF4);
        addressBox.setTextSize(22);
        addressBox.setSingleLine(true);
        addressBox.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_URI);
        addressBox.setImeOptions(EditorInfo.IME_ACTION_GO);
        addressBox.setOnEditorActionListener(new TextView.OnEditorActionListener() {
            @Override
            public boolean onEditorAction(TextView v, int id, android.view.KeyEvent e) {
                connect();
                return true;
            }
        });
        setup.addView(addressBox, new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));

        Button go = button("Connect", 0xFF0F1D2C, 0xFF4FD1C5, 22);
        go.setOnClickListener(new View.OnClickListener() { public void onClick(View v) { connect(); } });
        LinearLayout.LayoutParams gp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, dp(64));
        gp.topMargin = dp(14);
        setup.addView(go, gp);

        LinearLayout row = new LinearLayout(this);
        row.setOrientation(LinearLayout.HORIZONTAL);
        Button rm = button("Remove from list", 0xFFE8EEF4, 0xFF22364B, 17);
        rm.setOnClickListener(new View.OnClickListener() { public void onClick(View v) { removeTyped(); } });
        final Button exit = button("Exit", 0xFFE8EEF4, 0xFF22364B, 17);
        exitBtn = exit;
        // From the server screen opened out of a running session this is "Back" (return to the page); on first launch it quits.
        exit.setOnClickListener(new View.OnClickListener() { public void onClick(View v) { if (connected) hideStartup(); else finish(); } });
        LinearLayout.LayoutParams hp = new LinearLayout.LayoutParams(0, dp(56), 1f);
        hp.setMargins(0, dp(10), dp(8), 0);
        LinearLayout.LayoutParams hp2 = new LinearLayout.LayoutParams(0, dp(56), 1f);
        hp2.setMargins(dp(8), dp(10), 0, 0);
        row.addView(rm, hp);
        row.addView(exit, hp2);
        setup.addView(row);

        root.addView(scroll, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        setupScroll = scroll;
        scroll.setVisibility(View.GONE);
    }

    private ScrollView setupScroll;
    private Button exitBtn;

    private void showStartup() {
        String last = getSharedPreferences(PREFS, MODE_PRIVATE).getString(KEY_URL, "");
        setupNote.setText(servers().isEmpty() ? "Enter the address of your zibbit page."
                : connected ? "Pick a different server, or type a new address. Back returns to the one you are on."
                : "Pick a server, or type a new address.");
        setupNote.setTextColor(0xFFA9B8C6);
        exitBtn.setText(connected ? "Back" : "Exit");
        addressBox.setText(last);
        addressBox.setSelection(addressBox.getText().length());
        fillRows();
        web.setVisibility(View.GONE);
        setupScroll.setVisibility(View.VISIBLE);
    }

    private void fillRows() {
        serverRows.removeAllViews();
        for (final String u : servers()) {
            TextView t = new TextView(this);
            t.setText(u.replaceFirst("^https://", "").replaceFirst("/$", ""));
            t.setTextSize(20);
            t.setTextColor(0xFFE8EEF4);
            t.setGravity(Gravity.CENTER_VERTICAL);
            t.setPadding(dp(14), 0, dp(14), 0);
            int rowBg = u.equals(addressBox.getText().toString().trim()) ? 0xFF2B4560 : 0xFF1A2B3D;
            t.setBackgroundColor(rowBg);
            tvFocusable(t, rowBg, 0xFFE8EEF4, 0xFF9EC5FF);
            t.setOnClickListener(new View.OnClickListener() { public void onClick(View v) {
                addressBox.setText(u);
                addressBox.setSelection(u.length());
                fillRows();
            } });
            LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT, dp(60));
            lp.bottomMargin = dp(6);
            serverRows.addView(t, lp);
        }
    }

    private void hideStartup() {
        InputMethodManager im = (InputMethodManager) getSystemService(INPUT_METHOD_SERVICE);
        if (im != null) im.hideSoftInputFromWindow(addressBox.getWindowToken(), 0);
        setupScroll.setVisibility(View.GONE);
        web.setVisibility(View.VISIBLE);
        web.requestFocus();
    }

    private void removeTyped() {
        String url = normalize(addressBox.getText().toString());
        java.util.List<String> l = servers();
        if (url != null && l.remove(url)) {
            saveServers(l);
            addressBox.setText("");
            setupNote.setText("Removed.");
            setupNote.setTextColor(0xFFA9B8C6);
            fillRows();
        }
    }

    private void connect() {
        String url = normalize(addressBox.getText().toString());
        String bad = problem(url);
        if (bad != null) {
            setupNote.setText(bad);
            setupNote.setTextColor(0xFFFF8A80);
            return;
        }
        java.util.List<String> l = servers();
        if (!l.contains(url)) { l.add(url); saveServers(l); }
        getSharedPreferences(PREFS, MODE_PRIVATE).edit().putString(KEY_URL, url).apply();
        boolean changed = !url.equals(startUrl);
        setSite(url);
        hideStartup();
        if (changed || !connected) {
            connected = true;
            checkForUpdate(false);
            web.loadUrl(entryUrl());
            web.clearHistory();
        }
    }

    @SuppressWarnings("deprecation")
    private void hideSystemBars(boolean hide) {
        getWindow().getDecorView().setSystemUiVisibility(hide
                ? View.SYSTEM_UI_FLAG_FULLSCREEN | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                  | View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY | View.SYSTEM_UI_FLAG_LAYOUT_STABLE
                : View.SYSTEM_UI_FLAG_VISIBLE);
    }

    @Override
    protected void onSaveInstanceState(Bundle out) {
        super.onSaveInstanceState(out);
        web.saveState(out);
    }

    @Override
    public void onBackPressed() {
        if (customView != null) {
            web.getWebChromeClient().onHideCustomView();
        } else if (setupScroll.getVisibility() == View.VISIBLE) {
            if (connected) hideStartup(); else super.onBackPressed();
        } else if (isTv) {
            tvBack();
        } else if (web.canGoBack()) {
            web.goBack();
        } else {
            super.onBackPressed();
        }
    }

    /** On a TV, Back first goes to the TV page (close a pop-up, leave full screen, return to the list); when there is nothing left to back out of, press it twice to leave. */
    private void tvBack() {
        web.evaluateJavascript("(function(){try{return !!(window.ZibbitTV&&ZibbitTV.back());}catch(e){return false;}})()", new ValueCallback<String>() {
            @Override
            public void onReceiveValue(String v) {
                if ("true".equals(v)) return;
                long now = SystemClock.uptimeMillis();
                if (now - lastBack < 2500) {
                    web.evaluateJavascript("try{ZibbitTV.leave()}catch(e){}", null); // stops the stream before the page goes away
                    new Handler().postDelayed(new Runnable() { public void run() { finish(); } }, 250);
                } else {
                    lastBack = now;
                    Toast.makeText(MainActivity.this, "Press Back again to exit", Toast.LENGTH_SHORT).show();
                }
            }
        });
    }

    private boolean backFired = false;
    private final Handler backHandler = new Handler();
    private final Runnable backHold = new Runnable() {
        public void run() {
            if (backFired) return;
            backFired = true;
            Toast.makeText(MainActivity.this, "Back held: full screen", Toast.LENGTH_SHORT).show();
            if (web != null) web.evaluateJavascript("try{ZibbitTV.key('backhold')}catch(e){}", null);
        }
    };

    /** Remote-control keys the WebView would not pass to the page as ordinary keys. */
    @Override
    public boolean dispatchKeyEvent(KeyEvent e) {
        if (isTv && web != null && web.getVisibility() == View.VISIBLE && setupScroll.getVisibility() != View.VISIBLE && customView == null) {
            if (e.getKeyCode() == KeyEvent.KEYCODE_BACK) {
                // holding Back takes the channel in the preview to full screen; a short press is Back as usual, on release
                if (e.getAction() == KeyEvent.ACTION_DOWN) {
                    if (e.getRepeatCount() == 0) { backFired = false; backHandler.removeCallbacks(backHold); backHandler.postDelayed(backHold, 500); }
                } else if (e.getAction() == KeyEvent.ACTION_UP) {
                    backHandler.removeCallbacks(backHold);
                    if (!backFired && e.getEventTime() - e.getDownTime() >= 450) backHold.run(); // some remotes only report the press when it is let go
                    if (!backFired) onBackPressed();
                    backFired = false;
                }
                return true;
            }
            String name = null;
            switch (e.getKeyCode()) {
                case KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE: name = "playpause"; break;
                case KeyEvent.KEYCODE_MEDIA_PLAY: name = "play"; break;
                case KeyEvent.KEYCODE_MEDIA_PAUSE: name = "pause"; break;
                case KeyEvent.KEYCODE_MEDIA_STOP: name = "stop"; break;
                case KeyEvent.KEYCODE_CHANNEL_UP: name = "chup"; break;
                case KeyEvent.KEYCODE_CHANNEL_DOWN: name = "chdown"; break;
                case KeyEvent.KEYCODE_MENU: name = "menu"; break;
                default: break;
            }
            if (name != null) {
                if (e.getAction() == KeyEvent.ACTION_DOWN && e.getRepeatCount() == 0)
                    web.evaluateJavascript("try{ZibbitTV.key('" + name + "')}catch(e){}", null);
                return true;
            }
        }
        return super.dispatchKeyEvent(e);
    }


    /* ---- app updates: the server says which app version it offers; this downloads it and hands it to Android's installer ---- */

    private static final String ACTION_INSTALL = "app.zibbit.INSTALL_RESULT";
    private boolean updating;
    private BroadcastReceiver installResult;

    private int installedCode() {
        try { return getPackageManager().getPackageInfo(getPackageName(), 0).versionCode; } catch (Exception e) { return 0; }
    }

    private String installedName() {
        try { return getPackageManager().getPackageInfo(getPackageName(), 0).versionName; } catch (Exception e) { return "?"; }
    }

    /** Asks the server this app is connected to whether a newer app is published. Quiet unless there is one (or the person asked). */
    private void checkForUpdate(final boolean manual) {
        if (!connected || startUrl == null || updating) return;
        final String base = startUrl;
        new Thread(new Runnable() {
            public void run() {
                String err = null;
                org.json.JSONObject j = null;
                try {
                    java.net.HttpURLConnection c = (java.net.HttpURLConnection) new java.net.URL(base + "app/latest.json").openConnection();
                    c.setConnectTimeout(8000);
                    c.setReadTimeout(8000);
                    if (c.getResponseCode() == 200) {
                        java.io.ByteArrayOutputStream bo = new java.io.ByteArrayOutputStream();
                        java.io.InputStream in = c.getInputStream();
                        byte[] buf = new byte[4096];
                        int n;
                        while ((n = in.read(buf)) > 0 && bo.size() < 20000) bo.write(buf, 0, n);
                        in.close();
                        j = new org.json.JSONObject(bo.toString("UTF-8"));
                    } else if (c.getResponseCode() != 404) err = "The server answered " + c.getResponseCode() + ".";
                } catch (Exception e) {
                    err = "Could not reach the server.";
                }
                final org.json.JSONObject info = j;
                final String problem = err;
                runOnUiThread(new Runnable() {
                    public void run() {
                        if (isFinishing()) return;
                        if (info == null) { if (manual) toast(problem != null ? problem : "This server has no app update to offer."); return; }
                        int code = info.optInt("versionCode", 0);
                        if (code <= installedCode()) { if (manual) toast("Zibbit " + installedName() + " is the newest version."); return; }
                        askUpdate(base, info);
                    }
                });
            }
        }).start();
    }

    private void toast(String m) { Toast.makeText(this, m, Toast.LENGTH_LONG).show(); }

    private void askUpdate(final String base, final org.json.JSONObject info) {
        final String name = info.optString("versionName", "a newer version");
        AlertDialog d = new AlertDialog.Builder(this)
                .setTitle("Update available")
                .setMessage("Zibbit " + name + " is ready. You have " + installedName() + ".\n\nIt downloads from your server and Android asks you to confirm the install. Zibbit closes while it updates; open it again afterwards.")
                .setPositiveButton("Update", new android.content.DialogInterface.OnClickListener() {
                    public void onClick(android.content.DialogInterface x, int w) { startUpdate(base, info); }
                })
                .setNegativeButton("Not now", null)
                .create();
        d.show();
        Button ok = d.getButton(AlertDialog.BUTTON_POSITIVE);
        if (ok != null) ok.requestFocus();
    }

    private void startUpdate(final String base, final org.json.JSONObject info) {
        if (android.os.Build.VERSION.SDK_INT >= 26 && !getPackageManager().canRequestPackageInstalls()) {
            new AlertDialog.Builder(this)
                    .setTitle("Allow installs from Zibbit")
                    .setMessage("Android needs your permission before Zibbit can install its own update. Turn on \"Allow from this source\" for Zibbit, press Back, then choose Check for app update again.")
                    .setPositiveButton("Open settings", new android.content.DialogInterface.OnClickListener() {
                        public void onClick(android.content.DialogInterface x, int w) {
                            try {
                                startActivity(new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:" + getPackageName())));
                            } catch (Exception e) {
                                toast("Open Settings > Apps > Special app access > Install unknown apps, and allow Zibbit.");
                            }
                        }
                    })
                    .setNegativeButton("Cancel", null)
                    .show();
            return;
        }
        updating = true;
        final TextView msg = new TextView(this);
        msg.setText("Starting…");
        msg.setTextSize(18);
        msg.setPadding(dp(24), dp(16), dp(24), dp(8));
        final AlertDialog prog = new AlertDialog.Builder(this).setTitle("Updating Zibbit").setView(msg).setCancelable(false).create();
        prog.show();
        final String sha = info.optString("sha256", "");
        final long size = info.optLong("size", 0);
        new Thread(new Runnable() {
            public void run() {
                String fail = null;
                PackageInstaller.Session session = null;
                int id = -1;
                try {
                    PackageInstaller pi = getPackageManager().getPackageInstaller();
                    PackageInstaller.SessionParams sp = new PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL);
                    sp.setAppPackageName(getPackageName());
                    if (size > 0) sp.setSize(size);
                    id = pi.createSession(sp);
                    session = pi.openSession(id);
                    java.net.HttpURLConnection c = (java.net.HttpURLConnection) new java.net.URL(base + "app/Zibbit.apk").openConnection();
                    c.setConnectTimeout(10000);
                    c.setReadTimeout(20000);
                    if (c.getResponseCode() != 200) throw new java.io.IOException("The server answered " + c.getResponseCode() + ".");
                    java.security.MessageDigest md = java.security.MessageDigest.getInstance("SHA-256");
                    java.io.InputStream in = c.getInputStream();
                    java.io.OutputStream out = session.openWrite("zibbit.apk", 0, size > 0 ? size : -1);
                    byte[] buf = new byte[65536];
                    long got = 0;
                    int n, lastPct = -1;
                    while ((n = in.read(buf)) > 0) {
                        out.write(buf, 0, n);
                        md.update(buf, 0, n);
                        got += n;
                        final int pct = size > 0 ? (int) (got * 100 / size) : -1;
                        if (pct != lastPct) {
                            lastPct = pct;
                            runOnUiThread(new Runnable() { public void run() { msg.setText(pct >= 0 ? "Downloading… " + pct + "%" : "Downloading…"); } });
                        }
                    }
                    session.fsync(out);
                    out.close();
                    in.close();
                    StringBuilder hex = new StringBuilder();
                    for (byte b : md.digest()) hex.append(String.format("%02x", b));
                    if (size > 0 && got != size) throw new java.io.IOException("The download was cut short.");
                    if (!hex.toString().equalsIgnoreCase(sha)) throw new java.io.IOException("The download did not match what the server announced.");
                    runOnUiThread(new Runnable() { public void run() { msg.setText("Handing over to Android…"); } });
                    registerInstallResult();
                    Intent cb = new Intent(ACTION_INSTALL).setPackage(getPackageName());
                    int flags = PendingIntent.FLAG_UPDATE_CURRENT | (android.os.Build.VERSION.SDK_INT >= 31 ? PendingIntent.FLAG_MUTABLE : 0);
                    session.commit(PendingIntent.getBroadcast(MainActivity.this, id, cb, flags).getIntentSender());
                    session.close();
                    session = null;
                } catch (Exception e) {
                    fail = e.getMessage() != null ? e.getMessage() : "The update could not be downloaded.";
                    try { if (session != null) { session.abandon(); session.close(); } } catch (Exception ignore) { /* gone */ }
                }
                final String problem = fail;
                runOnUiThread(new Runnable() {
                    public void run() {
                        prog.dismiss();
                        updating = false;
                        if (problem != null) toast("Update failed. " + problem);
                    }
                });
            }
        }).start();
    }

    private void registerInstallResult() {
        if (installResult != null) return;
        installResult = new BroadcastReceiver() {
            @Override
            public void onReceive(Context ctx, Intent i) {
                int status = i.getIntExtra(PackageInstaller.EXTRA_STATUS, PackageInstaller.STATUS_FAILURE);
                if (status == PackageInstaller.STATUS_PENDING_USER_ACTION) {
                    Intent confirm = (Intent) i.getParcelableExtra(Intent.EXTRA_INTENT);
                    if (confirm != null) { confirm.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK); startActivity(confirm); }
                } else if (status != PackageInstaller.STATUS_SUCCESS) {
                    String m = i.getStringExtra(PackageInstaller.EXTRA_STATUS_MESSAGE);
                    toast("The update was not installed" + (m != null ? ": " + m : "."));
                }
            }
        };
        IntentFilter f = new IntentFilter(ACTION_INSTALL);
        if (android.os.Build.VERSION.SDK_INT >= 33) registerReceiver(installResult, f, Context.RECEIVER_NOT_EXPORTED);
        else registerReceiver(installResult, f);
    }

    @Override
    protected void onStart() {
        super.onStart();
        if (isTv && web != null) web.evaluateJavascript("try{ZibbitTV.hidden(false)}catch(e){}", null);
    }

    @Override
    protected void onStop() {
        // Home on a TV: the picture is gone, so the sound should be too, and the stream is stopped soon after
        if (isTv && web != null) web.evaluateJavascript("try{ZibbitTV.hidden(true)}catch(e){}", null);
        super.onStop();
    }

    @Override
    protected void onPause() {
        super.onPause();
        // Save the sign-in cookie. The WebView is not paused, so audio keeps
        // playing if you switch to another app.
        CookieManager.getInstance().flush();
    }

    @Override
    protected void onDestroy() {
        if (installResult != null) { try { unregisterReceiver(installResult); } catch (Exception ignore) { /* gone */ } installResult = null; }
        if (web != null) {
            root.removeAllViews();
            web.destroy();
        }
        super.onDestroy();
    }
}
