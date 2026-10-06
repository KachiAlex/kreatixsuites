package com.kreatixtech.suites;

import android.content.ContentResolver;
import android.content.Intent;
import android.database.Cursor;
import android.net.Uri;
import android.os.Build;
import android.provider.OpenableColumns;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.util.ArrayList;

/**
 * "Open with Kreatix" bridge — the WebView can't read content:// URIs handed
 * to the activity by other apps, so this plugin captures VIEW/SEND intents,
 * emits a "docOpen" event with the URI, and receive() materializes it into
 * the app files dir where JS can fetch() it via Capacitor.convertFileSrc.
 */
@CapacitorPlugin(name = "KxDocOpen")
public class KxDocOpenPlugin extends Plugin {

    private final ArrayList<String> pending = new ArrayList<>();

    @Override
    public void load() {
        inspect(getActivity().getIntent());
    }

    @Override
    public void handleOnNewIntent(Intent intent) {
        super.handleOnNewIntent(intent);
        inspect(intent);
    }

    private void inspect(Intent i) {
        if (i == null) return;
        ArrayList<Uri> uris = new ArrayList<>();
        if (Intent.ACTION_SEND.equals(i.getAction())) {
            Uri u = streamExtra(i);
            if (u != null) uris.add(u);
        } else if (Intent.ACTION_SEND_MULTIPLE.equals(i.getAction())) {
            ArrayList<Uri> list;
            if (Build.VERSION.SDK_INT >= 33) {
                list = i.getParcelableArrayListExtra(Intent.EXTRA_STREAM, Uri.class);
            } else {
                //noinspection deprecation
                list = i.getParcelableArrayListExtra(Intent.EXTRA_STREAM);
            }
            if (list != null) uris.addAll(list);
        } else {
            Uri u = i.getData();
            if (u != null) uris.add(u);
        }
        for (Uri u : uris) {
            String s = u.getScheme();
            if (!"content".equals(s) && !"file".equals(s)) continue;
            String str = u.toString();
            synchronized (pending) { pending.add(str); }
            JSObject ev = new JSObject();
            ev.put("uri", str);
            notifyListeners("docOpen", ev);
        }
    }

    private Uri streamExtra(Intent i) {
        if (Build.VERSION.SDK_INT >= 33) return i.getParcelableExtra(Intent.EXTRA_STREAM, Uri.class);
        //noinspection deprecation
        return i.getParcelableExtra(Intent.EXTRA_STREAM);
    }

    /** Cold-start drain — JS listeners may attach after the event fired. */
    @PluginMethod
    public void getPending(PluginCall call) {
        JSObject r = new JSObject();
        synchronized (pending) {
            if (!pending.isEmpty()) {
                r.put("uris", new com.getcapacitor.JSArray(pending));
                pending.clear();
            }
        }
        call.resolve(r);
    }

    /** Copy the content/file URI into filesDir/open-inbox and hand JS a path. */
    @PluginMethod
    public void receive(PluginCall call) {
        String raw = call.getString("uri");
        if (raw == null) { call.reject("uri required"); return; }
        try {
            Uri uri = Uri.parse(raw);
            ContentResolver cr = getContext().getContentResolver();
            String name = displayName(cr, uri);
            if (name == null || name.isEmpty()) {
                String seg = uri.getLastPathSegment();
                name = (seg == null || seg.isEmpty()) ? "document" : seg.substring(seg.lastIndexOf('/') + 1);
            }
            File dir = new File(getContext().getFilesDir(), "open-inbox");
            //noinspection ResultOfMethodCallIgnored
            dir.mkdirs();
            File out = new File(dir, name);
            try (InputStream in = cr.openInputStream(uri);
                 FileOutputStream fos = new FileOutputStream(out)) {
                if (in == null) { call.reject("couldn't open the file"); return; }
                byte[] buf = new byte[64 * 1024];
                int n;
                while ((n = in.read(buf)) != -1) fos.write(buf, 0, n);
            }
            JSObject r = new JSObject();
            r.put("path", out.getAbsolutePath());
            r.put("name", name);
            r.put("mime", cr.getType(uri));
            call.resolve(r);
        } catch (Exception e) {
            call.reject("Couldn't read the document — " + e.getMessage());
        }
    }

    private String displayName(ContentResolver cr, Uri uri) {
        if (!"content".equals(uri.getScheme())) return null;
        try (Cursor c = cr.query(uri, new String[]{OpenableColumns.DISPLAY_NAME}, null, null, null)) {
            if (c != null && c.moveToFirst() && !c.isNull(0)) return c.getString(0);
        } catch (Exception ignored) {}
        return null;
    }
}
