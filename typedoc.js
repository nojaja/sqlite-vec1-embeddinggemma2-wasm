module.exports = (async () => {
  const { Minimatch, GLOBSTAR } = await import("minimatch");

  if (!Minimatch.prototype.matchOne) {
    Minimatch.prototype.matchOne = function (file, pattern, partial = false) {
      const options = this.options;
      if (this.isWindows) {
        const fileDrive = typeof file[0] === "string" && /^[a-z]:$/i.test(file[0]);
        const fileUNC =
          !fileDrive &&
          file[0] === "" &&
          file[1] === "" &&
          file[2] === "?" &&
          /^[a-z]:$/i.test(file[3]);
        const patternDrive =
          typeof pattern[0] === "string" && /^[a-z]:$/i.test(pattern[0]);
        const patternUNC =
          !patternDrive &&
          pattern[0] === "" &&
          pattern[1] === "" &&
          pattern[2] === "?" &&
          typeof pattern[3] === "string" &&
          /^[a-z]:$/i.test(pattern[3]);

        const fdi = fileUNC ? 3 : fileDrive ? 0 : undefined;
        const pdi = patternUNC ? 3 : patternDrive ? 0 : undefined;
        if (typeof fdi === "number" && typeof pdi === "number") {
          const [fd, pd] = [file[fdi], pattern[pdi]];
          if (fd.toLowerCase() === pd.toLowerCase()) {
            pattern[pdi] = fd;
            if (pdi > fdi) {
              pattern = pattern.slice(pdi);
            } else if (fdi > pdi) {
              file = file.slice(fdi);
            }
          }
        }
      }

      let fi = 0;
      let pi = 0;
      const fl = file.length;
      const pl = pattern.length;

      for (; fi < fl && pi < pl; fi++, pi++) {
        const p = pattern[pi];
        const f = file[fi];

        if (p === false) return false;

        if (p === GLOBSTAR) {
          let fr = fi;
          const pr = pi + 1;
          if (pr === pl) {
            for (; fi < fl; fi++) {
              if (
                file[fi] === "." ||
                file[fi] === ".." ||
                (!options.dot && file[fi].charAt(0) === ".")
              ) {
                return false;
              }
            }
            return true;
          }

          while (fr < fl) {
            const swallowee = file[fr];
            if (this.matchOne(file.slice(fr), pattern.slice(pr), partial)) {
              return true;
            } else {
              if (
                swallowee === "." ||
                swallowee === ".." ||
                (!options.dot && swallowee.charAt(0) === ".")
              ) {
                break;
              }
              fr++;
            }
          }

          if (partial && fr === fl) {
            return true;
          }
          return false;
        }

        let hit = false;
        if (typeof p === "string") {
          hit = f === p;
        } else if (p && typeof p.test === "function") {
          hit = p.test(f);
        }
        if (!hit) return false;
      }

      if (fi === fl && pi === pl) {
        return true;
      } else if (fi === fl) {
        return partial;
      } else if (pi === pl) {
        return fi === fl - 1 && file[fi] === "";
      } else {
        return false;
      }
    };
  }

  return {
    entryPoints: ["src/index.ts"],
    tsconfig: "tsconfig.build.json",
    plugin: ["typedoc-plugin-markdown"],
    out: "docs/typedoc-md",
    readme: "none",
    disableSources: true,
    excludePrivate: true,
    excludeProtected: true,
    validation: { notExported: true, invalidLink: true, notDocumented: true },
    treatWarningsAsErrors: true
  };
})();
