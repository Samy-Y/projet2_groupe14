import pandas as pd
import matplotlib.pyplot as plt
import numpy as np
import os

# Configuration pour export PGF natif LaTeX
import matplotlib
matplotlib.use("pgf")
matplotlib.rcParams.update({
    "pgf.texsystem": "xelatex",
    "font.family": "sans-serif",
    "text.usetex": True,
    "pgf.rcfonts": False,
    "axes.labelsize": 10,
    "font.size": 10,
    "legend.fontsize": 8,
    "xtick.labelsize": 8,
    "ytick.labelsize": 8,
})

def generer_histogramme_pgf():
    chemin_csv = 'experience/res_globaux.csv'
    chemin_pgf = 'experience/histogramme_vibrations.pgf'
    
    if not os.path.exists(chemin_csv):
        print(f"Erreur : Le fichier {chemin_csv} est introuvable.")
        return

    # Chargement et calculs
    df = pd.read_csv(chemin_csv)
    df['Net'] = np.abs(df['Magnitude'] - 9.81)

    fig, ax = plt.subplots(figsize=(6.5, 4))
    
    # Tracé de l'histogramme complet
    ax.bar(df['RPM'], df['Net'], width=1.5, color='#0056b3', alpha=0.8, edgecolor='black', linewidth=0.3)
    
    # Identification des zones
    # 1. Zone chaotique (Sauts de pas : 80-115 RPM)
    ax.axvspan(80, 115, color='#c65050', alpha=0.2, label=r'Zone chaotique (Perte de pas)')
    
    # 2. Zone Hors CdCf (Stable mais > 80 mm/s : 120-150 RPM)
    ax.axvspan(120, 150, color='#2ca02c', alpha=0.2, hatch='//', label=r'Zone stable (Hors CdCf $> 80$ mm/s)')
    
    # 3. Zone de travail valide [0-120 RPM] - Implicite, mais on cherche le min avant 80 RPM
    zone_valide = df[df['RPM'] < 80]
    idx_min = zone_valide['Net'].idxmin()
    min_rpm = zone_valide.loc[idx_min, 'RPM']
    min_val = zone_valide.loc[idx_min, 'Net']
    
    # Marquage du minimum global dans la zone utile
    ax.scatter(min_rpm, min_val, color='gold', edgecolor='black', s=50, zorder=5)
    ax.annotate(rf'$V_{{min}}$ idéal ({min_rpm} RPM)', 
                xy=(min_rpm, min_val), xytext=(0, 15), textcoords='offset points',
                ha='center', fontsize=8, fontweight='bold',
                bbox=dict(boxstyle='round,pad=0.2', fc='white', alpha=0.8))

    # Mise en forme
    ax.set_title(r"Caractérisation vibratoire globale du moteur NEMA 17")
    ax.set_xlabel(r"Vitesse de consigne (RPM)")
    ax.set_ylabel(r"Accélération nette $|a - g|$ (m/s$^2$)")
    
    # Ligne verticale pour la limite du CdCf
    ax.axvline(x=120, color='black', linestyle='--', linewidth=1, label=r'Limite CdCf ($V_{max} = 80$ mm/s)')
    
    ax.grid(axis='y', linestyle=':', alpha=0.6)
    ax.legend(loc='upper right')
    
    plt.tight_layout()
    plt.savefig(chemin_pgf)
    print(f"Graphique exporté avec succès vers {chemin_pgf}")

if __name__ == "__main__":
    generer_histogramme_pgf()