# v0.0.1 Linux再生成環境の準備

## 1. 適用範囲

コンテナをビルド基盤に使う場合、明示的な別指定がなければ `emscripten/emsdk:6.0.8`（Linux x64）を使用する。

基準の生成処理が直接使う資材に限定する。汎用Debian rootfsを構築するためのAPT bootstrap、build-essential、Tcl dev、Python venv、Git/curl等の追加一律取得は不要である。取得hostのNode/npm/Git/curlと、Linux x64/glibc基盤のsh/ar/tar/unzip等は環境の前提とし、搬入する資材と混同しない。

host debはOS全体へinstallせずrun専用directoryへ展開する。基盤glibcを上書きしない。基準処理が使う94配置pathは、重複を除くと85種類のdebである。同じfileを再取得する必要はないが、3集合の相対保存先は維持する。

---

## 2. SQLite用host集合

保存先は `downloads/sqlite-official-host`。以下の77debを使う。gcc、make、Tcl、zip等とその対応library/headerを含む。Packages.gzは取得metadataでありdeb数に含めない。

```text
base-files_12.4+deb12u15_amd64.deb
bash_5.2.15-2+b13_amd64.deb
binutils-common_2.40-2_amd64.deb
binutils-x86-64-linux-gnu_2.40-2_amd64.deb
binutils_2.40-2_amd64.deb
cpp-12_12.2.0-14+deb12u1_amd64.deb
cpp_12.2.0-3_amd64.deb
debconf_1.5.82_all.deb
debianutils_5.7-0.5~deb12u1_amd64.deb
dpkg_1.21.23_amd64.deb
gawk_5.2.1-2_amd64.deb
gcc-12-base_12.2.0-14+deb12u1_amd64.deb
gcc-12_12.2.0-14+deb12u1_amd64.deb
gcc_12.2.0-3_amd64.deb
grep_3.8-5_amd64.deb
libacl1_2.3.1-3_amd64.deb
libasan8_12.2.0-14+deb12u1_amd64.deb
libatomic1_12.2.0-14+deb12u1_amd64.deb
libbinutils_2.40-2_amd64.deb
libbz2-1.0_1.0.8-5+b1_amd64.deb
libc-dev-bin_2.36-9+deb12u14_amd64.deb
libc6-dev_2.36-9+deb12u14_amd64.deb
libc6_2.36-9+deb12u14_amd64.deb
libcc1-0_12.2.0-14+deb12u1_amd64.deb
libcom-err2_1.47.0-2+b2_amd64.deb
libcrypt-dev_4.4.33-2_amd64.deb
libcrypt1_4.4.33-2_amd64.deb
libctf-nobfd0_2.40-2_amd64.deb
libctf0_2.40-2_amd64.deb
libffi8_3.4.4-1_amd64.deb
libgcc-12-dev_12.2.0-14+deb12u1_amd64.deb
libgcc-s1_12.2.0-14+deb12u1_amd64.deb
libgmp10_6.2.1+dfsg1-1.1_amd64.deb
libgomp1_12.2.0-14+deb12u1_amd64.deb
libgprofng0_2.40-2_amd64.deb
libgssapi-krb5-2_1.20.1-2+deb12u5_amd64.deb
libisl23_0.25-1.1_amd64.deb
libitm1_12.2.0-14+deb12u1_amd64.deb
libjansson4_2.14-2_amd64.deb
libk5crypto3_1.20.1-2+deb12u5_amd64.deb
libkeyutils1_1.6.3-2_amd64.deb
libkrb5-3_1.20.1-2+deb12u5_amd64.deb
libkrb5support0_1.20.1-2+deb12u5_amd64.deb
liblsan0_12.2.0-14+deb12u1_amd64.deb
liblzma5_5.4.1-1+deb12u1_amd64.deb
libmd0_1.0.4-2_amd64.deb
libmpc3_1.3.1-1_amd64.deb
libmpfr6_4.2.0-1_amd64.deb
libnsl-dev_1.3.0-2_amd64.deb
libnsl2_1.3.0-2_amd64.deb
libpcre2-8-0_10.42-1_amd64.deb
libquadmath0_12.2.0-14+deb12u1_amd64.deb
libreadline8_8.2-1.3_amd64.deb
libselinux1_3.4-1+b6_amd64.deb
libsigsegv2_2.14-1_amd64.deb
libssl3_3.0.20-1~deb12u2_amd64.deb
libstdc++6_12.2.0-14+deb12u1_amd64.deb
libtcl8.6_8.6.13+dfsg-2_amd64.deb
libtinfo6_6.4-4_amd64.deb
libtirpc-common_1.3.3+ds-1_all.deb
libtirpc-dev_1.3.3+ds-1_amd64.deb
libtirpc3_1.3.3+ds-1_amd64.deb
libtsan2_12.2.0-14+deb12u1_amd64.deb
libubsan1_12.2.0-14+deb12u1_amd64.deb
libzstd1_1.5.4+dfsg2-5_amd64.deb
linux-libc-dev_6.1.176-1_amd64.deb
make_4.3-4.1_amd64.deb
patch_2.7.6-7_amd64.deb
readline-common_8.2-1.3_all.deb
rpcsvc-proto_1.4.3-1_amd64.deb
sed_4.9-1+deb12u1_amd64.deb
tar_1.34+dfsg-1.2+deb12u1_amd64.deb
tcl8.6_8.6.13+dfsg-2_amd64.deb
tzdata_2026b-0+deb12u1_all.deb
wabt_1.0.32-1_amd64.deb
zip_3.0-13_amd64.deb
zlib1g_1.2.13.dfsg-1_amd64.deb
```

---

## 3. PythonとORT runtime集合

`downloads/python-debian` の13debを共用する。Python実行fileを含め、libpythonだけで代用しない。

```text
libexpat1_2.5.0-1+deb12u2_amd64.deb
libncursesw6_6.4-4_amd64.deb
libnsl2_1.3.0-2_amd64.deb
libpython3.11-minimal_3.11.2-6+deb12u8_amd64.deb
libpython3.11-stdlib_3.11.2-6+deb12u8_amd64.deb
libreadline8_8.2-1.3_amd64.deb
libsqlite3-0_3.40.1-2+deb12u2_amd64.deb
libtirpc-common_1.3.3+ds-1_all.deb
libtirpc3_1.3.3+ds-1_amd64.deb
media-types_10.0.0_all.deb
python3.11-minimal_3.11.2-6+deb12u8_amd64.deb
python3.11_3.11.2-6+deb12u8_amd64.deb
readline-common_8.2-1.3_all.deb
```

取得元はDebian bookworm/mainの署名付きmetadataで確認し、Package/Version/Architecture/Filenameを対応付ける。直接URLは `https://deb.debian.org/debian/` とFilenameを連結する。metadata取得URLは `https://deb.debian.org/debian/dists/bookworm/main/binary-amd64/Packages.gz` 。

---

## 4. 専用directoryへの展開

| builder | 展開する集合と利用方法 |
| --- | --- |
| SQLite | sqlite-official-host/*.debとpython-debian/*.debを新規host rootへ展開。gccはそのrootのsysroot/GCC_EXEC_PREFIXを使うwrapperから起動。make/Tcl/Pythonは展開rootを明示する |

debはarでdata.tar.xzまたはdata.tar.gzを取り出して専用rootへ展開する。OS全体へのdpkg/apt installやglibc差替えを前提にしない。SQLiteのhost overlayは基盤のloader/libc/libm等を上書きせず、必要な他libraryを参照する。TCL_LIBRARY、TCL8_6_TM_PATH、PYTHONHOME、EMSDK_PYTHON、PATH、LD_LIBRARY_PATHはそのrunと子process内だけに設定する。

---

## 5. Linux側の準備完了チェック

SQLite再生成を開始する前に、専用sysrootのgcc wrapperでhost Cをcompile・実行し、展開したmake、tclsh8.6、python3.11と標準libraryが動くことを確認する。
全toolの実起動確認が成功してから、`ext/wasm` での `make -j2 npm` ビルド工程へ進む。
