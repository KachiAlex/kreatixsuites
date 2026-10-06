package com.kreatixtech.suites;

import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(KxDocOpenPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
