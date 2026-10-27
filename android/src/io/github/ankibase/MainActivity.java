package io.github.ankibase;

import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageInfo;
import android.content.res.AssetManager;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.view.HapticFeedbackConstants;
import android.view.View;
import android.view.Window;
import android.view.WindowInsets;
import android.view.WindowInsetsController;
import android.webkit.JavascriptInterface;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;

import org.json.JSONObject;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;

/**
 * AnkiBase's web UI, full screen, served by the app's core on 127.0.0.1. Behaves like an
 * app: drawn edge to edge with the page told the system bars' sizes (as CSS variables
 * --safe-top etc.), no zooming, the system bars following the theme, the back button going
 * back, files picked for imports, and links out of the app opening in the browser.
 */
public class MainActivity extends Activity {
    private static final int PICK_FILE = 1;

    private FrameLayout root;
    private WebView web;
    private ValueCallback<Uri[]> pendingFiles;
    private String origin;
    /** The system bars' sizes in CSS pixels: top, right, bottom, left. */
    private final float[] insets = new float[4];
    private SharedPreferences prefs;

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        prefs = getSharedPreferences("ankibase", MODE_PRIVATE);
        Window window = getWindow();
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            window.setDecorFitsSystemWindows(false);
        } else {
            window.getDecorView().setSystemUiVisibility(View.SYSTEM_UI_FLAG_LAYOUT_STABLE
                    | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION);
        }
        window.setStatusBarColor(Color.TRANSPARENT);
        window.setNavigationBarColor(Color.TRANSPARENT);

        root = new FrameLayout(this);
        int background = prefs.getInt("bar", Color.rgb(0x16, 0x21, 0x3e));
        root.setBackgroundColor(background);
        web = new WebView(this);
        web.setBackgroundColor(background);
        root.addView(web, new FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT,
                FrameLayout.LayoutParams.MATCH_PARENT));
        setContentView(root);
        applyBars(prefs.getBoolean("dark", true));
        root.setOnApplyWindowInsetsListener(this::onInsets);

        WebSettings settings = web.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setMediaPlaybackRequiresUserGesture(false);
        settings.setSupportZoom(false);
        settings.setBuiltInZoomControls(false);
        settings.setTextZoom(100);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(false);
        web.setOverScrollMode(View.OVER_SCROLL_IF_CONTENT_SCROLLS);
        web.addJavascriptInterface(new Bridge(), "AnkiBaseAndroid");
        web.setWebViewClient(new Client());
        web.setWebChromeClient(new Chrome());

        new Thread(this::startCore, "ankibase-start").start();
    }

    /** Unpacks the web UI (once per app version) and starts the core, then loads the app. */
    private void startCore() {
        String result;
        try {
            PackageInfo info = getPackageManager().getPackageInfo(getPackageName(), 0);
            String version = info.versionName;
            long build = Build.VERSION.SDK_INT >= Build.VERSION_CODES.P ? info.getLongVersionCode() : info.versionCode;
            File assets = new File(getFilesDir(), "assets-" + build);
            if (!new File(assets, ".complete").exists()) {
                deleteTree(assets.getParentFile(), "assets-");
                copyAssets("web", new File(assets, "web"));
                copyAssets("pages", new File(assets, "pages"));
                new File(assets, ".complete").createNewFile();
            }
            JSONObject config = new JSONObject();
            config.put("dir", new File(getFilesDir(), "ankibase").getPath());
            config.put("web", new File(assets, "web").getPath());
            config.put("pages", new File(assets, "pages").getPath());
            String server = getString(R.string.default_server);
            if (!server.isEmpty()) config.put("default_server", server);
            String feed = getString(R.string.update_feed);
            if (!feed.isEmpty()) config.put("update_feed", feed);
            config.put("version", version);
            config.put("build", String.valueOf(build));
            config.put("bundle_id", getPackageName());
            result = Core.start(config.toString());
        } catch (Exception e) {
            result = "{\"error\": " + JSONObject.quote(String.valueOf(e)) + "}";
        }
        final String started = result;
        new Handler(Looper.getMainLooper()).post(() -> load(started));
    }

    private void load(String started) {
        try {
            JSONObject json = new JSONObject(started);
            if (json.has("error")) {
                web.loadData("<body style='background:#16213e;color:#eee;font-family:sans-serif;padding:2em'>"
                        + "<h3>AnkiBase couldn't start</h3><p>" + json.getString("error") + "</p>", "text/html", "utf-8");
                return;
            }
            origin = "http://127.0.0.1:" + json.getInt("port");
            web.loadUrl(origin + "/__start?token=" + json.getString("token"));
        } catch (Exception e) {
            web.loadData("AnkiBase couldn't start: " + e, "text/plain", "utf-8");
        }
    }

    private void copyAssets(String path, File target) throws IOException {
        AssetManager manager = getAssets();
        String[] children = manager.list(path);
        if (children != null && children.length > 0) {
            target.mkdirs();
            for (String child : children) copyAssets(path + "/" + child, new File(target, child));
            return;
        }
        target.getParentFile().mkdirs();
        try (InputStream in = manager.open(path); OutputStream out = new FileOutputStream(target)) {
            byte[] buffer = new byte[64 * 1024];
            int read;
            while ((read = in.read(buffer)) > 0) out.write(buffer, 0, read);
        }
    }

    private static void deleteTree(File dir, String prefix) {
        File[] files = dir.listFiles();
        if (files == null) return;
        for (File file : files) {
            if (prefix == null || file.getName().startsWith(prefix)) {
                if (file.isDirectory()) deleteTree(file, null);
                file.delete();
            }
        }
    }

    // ── System bars ─────────────────────────────────────────────────────────

    private WindowInsets onInsets(View view, WindowInsets windowInsets) {
        float density = getResources().getDisplayMetrics().density;
        int top, right, bottom, left, keyboard;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            android.graphics.Insets bars = windowInsets.getInsets(WindowInsets.Type.systemBars() | WindowInsets.Type.displayCutout());
            android.graphics.Insets ime = windowInsets.getInsets(WindowInsets.Type.ime());
            top = bars.top; right = bars.right; bottom = bars.bottom; left = bars.left; keyboard = ime.bottom;
        } else {
            top = windowInsets.getSystemWindowInsetTop(); right = windowInsets.getSystemWindowInsetRight();
            bottom = windowInsets.getSystemWindowInsetBottom(); left = windowInsets.getSystemWindowInsetLeft();
            // Before Android 11 the bottom inset includes the keyboard when it's open.
            keyboard = bottom > 300 * density ? bottom : 0;
            if (keyboard > 0) bottom = 0;
        }
        // The keyboard shrinks the page (it's drawn edge to edge, so adjustResize alone doesn't).
        root.setPadding(0, 0, 0, keyboard);
        insets[0] = top / density; insets[1] = right / density;
        insets[2] = keyboard > 0 ? 0 : bottom / density; insets[3] = left / density;
        pushInsets();
        return windowInsets;
    }

    private void pushInsets() {
        if (web == null) return;
        web.evaluateJavascript(String.format(java.util.Locale.ROOT,
                "(function(s){s.setProperty('--safe-top','%.1fpx');s.setProperty('--safe-right','%.1fpx');"
                        + "s.setProperty('--safe-bottom','%.1fpx');s.setProperty('--safe-left','%.1fpx');})"
                        + "(document.documentElement.style)", insets[0], insets[1], insets[2], insets[3]), null);
    }

    /** Light or dark icons in the status and navigation bars. */
    @SuppressWarnings("deprecation")
    private void applyBars(boolean dark) {
        View decor = getWindow().getDecorView();
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            WindowInsetsController controller = decor.getWindowInsetsController();
            if (controller == null) return;
            int light = WindowInsetsController.APPEARANCE_LIGHT_STATUS_BARS | WindowInsetsController.APPEARANCE_LIGHT_NAVIGATION_BARS;
            controller.setSystemBarsAppearance(dark ? 0 : light, light);
        } else {
            int flags = decor.getSystemUiVisibility();
            flags = dark ? flags & ~View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR : flags | View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR;
            decor.setSystemUiVisibility(flags);
        }
    }

    // ── The page's messages (frontend/src/native.ts) ──────────────────────────

    private final class Bridge {
        @JavascriptInterface
        public String info() {
            try {
                PackageInfo info = getPackageManager().getPackageInfo(getPackageName(), 0);
                long build = Build.VERSION.SDK_INT >= Build.VERSION_CODES.P ? info.getLongVersionCode() : info.versionCode;
                return new JSONObject().put("version", info.versionName).put("build", String.valueOf(build))
                        .put("platform", "android").toString();
            } catch (Exception e) {
                return "{\"version\":\"\",\"build\":\"\",\"platform\":\"android\"}";
            }
        }

        @JavascriptInterface
        public void postMessage(String message) {
            runOnUiThread(() -> handle(message));
        }
    }

    private void handle(String message) {
        try {
            JSONObject json = new JSONObject(message);
            switch (json.optString("type")) {
                case "theme": {
                    int bar = Color.parseColor(json.optString("bar", "#16213e"));
                    boolean dark = json.optBoolean("dark", true);
                    root.setBackgroundColor(bar);
                    web.setBackgroundColor(bar);
                    applyBars(dark);
                    prefs.edit().putInt("bar", bar).putBoolean("dark", dark).apply();
                    break;
                }
                case "haptic":
                    web.performHapticFeedback("success".equals(json.optString("style"))
                            ? HapticFeedbackConstants.CONFIRM : HapticFeedbackConstants.KEYBOARD_TAP);
                    break;
                default:
                    break;
            }
        } catch (Exception ignored) {
            // A message this version doesn't know.
        }
    }

    // ── Navigation, files ─────────────────────────────────────────────────────

    private final class Client extends WebViewClient {
        @Override
        public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
            Uri url = request.getUrl();
            if (origin != null && url.toString().startsWith(origin + "/")) return false;
            // Links out of the app open in the browser (or the app they belong to).
            try {
                startActivity(new Intent(Intent.ACTION_VIEW, url));
            } catch (ActivityNotFoundException ignored) {
                // Nothing can open it.
            }
            return true;
        }

        @Override
        public void onPageFinished(WebView view, String url) {
            pushInsets();
        }
    }

    private final class Chrome extends WebChromeClient {
        @Override
        public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback, FileChooserParams params) {
            if (pendingFiles != null) pendingFiles.onReceiveValue(null);
            pendingFiles = callback;
            Intent pick = new Intent(Intent.ACTION_GET_CONTENT).addCategory(Intent.CATEGORY_OPENABLE).setType("*/*");
            try {
                startActivityForResult(Intent.createChooser(pick, null), PICK_FILE);
            } catch (ActivityNotFoundException e) {
                pendingFiles = null;
                return false;
            }
            return true;
        }
    }

    @Override
    protected void onActivityResult(int request, int result, Intent data) {
        if (request == PICK_FILE && pendingFiles != null) {
            pendingFiles.onReceiveValue(WebChromeClient.FileChooserParams.parseResult(result, data));
            pendingFiles = null;
            return;
        }
        super.onActivityResult(request, result, data);
    }

    @Override
    @SuppressWarnings("deprecation")
    public void onBackPressed() {
        if (web != null && web.canGoBack()) {
            web.goBack();
        } else {
            super.onBackPressed();
        }
    }

    @Override
    protected void onPause() {
        super.onPause();
        if (web != null) web.onPause();
    }

    @Override
    protected void onResume() {
        super.onResume();
        if (web != null) web.onResume();
    }
}
